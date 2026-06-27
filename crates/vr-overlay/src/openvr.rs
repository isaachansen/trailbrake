//! OpenVR (SteamVR) backend — the working path.
//!
//! Built on the `ovr_overlay` crate (a thin `autocxx` wrapper over the OpenVR
//! `IVROverlay` interface). We hold a [`Context`] to keep the runtime
//! initialised and create a fresh `OverlayManager` per call — that's cheap, it
//! just re-fetches the global `VROverlay()` interface pointer, and it sidesteps
//! the self-referential-borrow problem of storing the manager alongside the
//! context.
//!
//! Notes / limitations:
//! - Panels live in **seated** tracking space, so they recenter naturally when
//!   the user recenters their seated pose in SteamVR / the sim. `ovr_overlay`
//!   doesn't expose a seated-reset or HMD-pose getter, so [`recenter`] is a
//!   best-effort no-op that defers to SteamVR's own recenter.
//! - `ovr_overlay` 0.0.0 has no `DestroyOverlay` wrapper, so [`remove`] hides the
//!   panel; everything is torn down for real on [`shutdown`] (`VR_Shutdown`).
//! - `ovr_overlay::create_overlay` passes the key/name `&str` to C without a NUL
//!   terminator, so we append one ourselves.

use std::collections::HashMap;

use ovr_overlay::overlay::OverlayHandle;
use ovr_overlay::pose::{Matrix3x4, TrackingUniverseOrigin};
use ovr_overlay::{Context, TrackedDeviceIndex};

use crate::backend::VrBackend;
use crate::VrError;

pub struct OpenVrBackend {
    // `Option` so `shutdown` can consume the context (its `shutdown` takes self).
    ctx: Option<Context>,
    overlays: HashMap<String, OverlayHandle>,
}

impl OpenVrBackend {
    pub fn new() -> Result<Self, VrError> {
        let ctx = Context::init()
            .map_err(|e| VrError::Unsupported(format!("OpenVR init failed (is SteamVR running?): {e}")))?;
        Ok(Self {
            ctx: Some(ctx),
            overlays: HashMap::new(),
        })
    }

    fn ctx(&self) -> Result<&Context, VrError> {
        self.ctx
            .as_ref()
            .ok_or_else(|| VrError::Runtime("OpenVR context already shut down".into()))
    }
}

impl VrBackend for OpenVrBackend {
    fn name(&self) -> &'static str {
        "OpenVR"
    }

    fn ensure_overlay(&mut self, id: &str) -> Result<(), VrError> {
        if self.overlays.contains_key(id) {
            return Ok(());
        }
        let ctx = self.ctx()?;
        let mut mngr = ctx.overlay_mngr();
        // NUL-terminate: the crate forwards these straight to C without one.
        let key = format!("trailbrake.widget.{id}\0");
        let name = format!("Trailbrake {id}\0");
        let handle = mngr
            .create_overlay(&key, &name)
            .map_err(|e| VrError::Runtime(format!("create overlay {id}: {e:?}")))?;
        self.overlays.insert(id.to_string(), handle);
        Ok(())
    }

    fn push_frame(&mut self, id: &str, rgba: &[u8], w: u32, h: u32) -> Result<(), VrError> {
        let handle = match self.overlays.get(id) {
            Some(h) => *h,
            None => return Ok(()),
        };
        let ctx = self.ctx()?;
        let mut mngr = ctx.overlay_mngr();
        mngr.set_raw_data(handle, rgba, w as usize, h as usize, 4)
            .map_err(|e| VrError::Runtime(format!("set_raw_data {id}: {e:?}")))
    }

    fn set_transform(
        &mut self,
        id: &str,
        matrix: [[f32; 4]; 3],
        width_m: f32,
        curvature: f32,
        head_locked: bool,
    ) {
        let handle = match self.overlays.get(id) {
            Some(h) => *h,
            None => return,
        };
        let ctx = match self.ctx() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut mngr = ctx.overlay_mngr();
        let m = Matrix3x4(matrix);
        let _ = mngr.set_width(handle, width_m.max(0.05));
        let _ = mngr.set_curvature(handle, curvature.clamp(0.0, 1.0));
        if head_locked {
            let _ = mngr.set_transform_tracked_device_relative(handle, TrackedDeviceIndex::HMD, &m);
        } else {
            let _ = mngr.set_transform_absolute(
                handle,
                TrackingUniverseOrigin::TrackingUniverseSeated,
                &m,
            );
        }
    }

    fn set_visible(&mut self, id: &str, visible: bool) {
        if let Some(&handle) = self.overlays.get(id) {
            if let Ok(ctx) = self.ctx() {
                let _ = ctx.overlay_mngr().set_visibility(handle, visible);
            }
        }
    }

    fn remove(&mut self, id: &str) {
        // No DestroyOverlay wrapper in ovr_overlay 0.0.0 — hide it and forget the
        // handle. It's reclaimed on VR_Shutdown.
        self.set_visible(id, false);
        self.overlays.remove(id);
    }

    fn recenter(&mut self) {
        // Panels are in seated space; recentering is done via SteamVR's own
        // seated reset, which moves the origin (and our panels) with it.
    }

    fn poll(&mut self) -> bool {
        // ovr_overlay doesn't surface the event queue; the manager's stop flag
        // drives teardown. Keep running.
        true
    }

    fn shutdown(&mut self) {
        self.overlays.clear();
        if let Some(ctx) = self.ctx.take() {
            // Safety: we own the context, the render thread is the only user, and
            // we never touch it again after this.
            unsafe { ctx.shutdown() };
        }
    }
}
