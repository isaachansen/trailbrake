//! OpenXR backend — best-effort, behind the `openxr` feature.
//!
//! Overlay compositing in OpenXR is the provisional `XR_EXTX_overlay` extension.
//! As of today **no shipping runtime implements it** (SteamVR, Windows Mixed
//! Reality, and Meta all leave it out of `xrEnumerateInstanceExtensionProperties`),
//! so an OpenXR app cannot draw on top of another running app. We therefore:
//!
//! 1. Load the OpenXR loader dynamically (a missing runtime is a graceful error,
//!    not a link failure).
//! 2. Enumerate extensions and check for `XR_EXTX_overlay`.
//! 3. If absent — the universal case right now — return [`VrError::Unsupported`]
//!    so the manager falls back to OpenVR.
//!
//! The full composite path (an overlay session plus one `XrCompositionLayerQuad`
//! per widget over D3D11 swapchains) is intentionally **not** implemented: there
//! is no runtime to exercise or validate it against. This module exists so the
//! backend lights up automatically once a runtime ships the extension — the
//! detection is real, only the unreachable rendering path is deferred.

use crate::backend::VrBackend;
use crate::VrError;

pub struct OpenXrBackend {
    // Held to keep the loader alive once a runtime actually supports overlays.
    _entry: openxr::Entry,
}

impl OpenXrBackend {
    pub fn new() -> Result<Self, VrError> {
        // `Entry::load` is `unsafe` in some crate versions and safe in others;
        // the allow keeps both compiling.
        #[allow(unused_unsafe)]
        let entry = unsafe { openxr::Entry::load() }
            .map_err(|e| VrError::Unsupported(format!("OpenXR loader not found: {e}")))?;

        let exts = entry
            .enumerate_extensions()
            .map_err(|e| VrError::Unsupported(format!("OpenXR enumerate extensions: {e}")))?;

        if !exts.extx_overlay {
            return Err(VrError::Unsupported(
                "runtime lacks XR_EXTX_overlay (no shipping OpenXR runtime supports \
                 overlay compositing yet) — falling back to OpenVR"
                    .into(),
            ));
        }

        // A runtime that exposes the extension does exist on this machine. The
        // quad-layer composite path is unimplemented because it's never been
        // reachable to test; report it clearly rather than silently no-op.
        Err(VrError::Unsupported(
            "XR_EXTX_overlay is present, but the OpenXR composite path is not yet \
             implemented (untestable on current runtimes) — using OpenVR"
                .into(),
        ))

        // When implementing: create an Instance with XR_EXTX_overlay enabled, an
        // overlay Session (XrSessionCreateInfoOverlayEXTX), a D3D11 swapchain per
        // widget, and submit one XrCompositionLayerQuad per panel each frame in
        // xrEndFrame, positioned with the same math as `transform::panel_transform`.
        #[allow(unreachable_code)]
        Ok(Self { _entry: entry })
    }
}

// Methods are unreachable today (construction always errors), but the trait must
// be satisfied so the backend slots into the manager once `new` can succeed.
impl VrBackend for OpenXrBackend {
    fn name(&self) -> &'static str {
        "OpenXR"
    }
    fn ensure_overlay(&mut self, _id: &str) -> Result<(), VrError> {
        Ok(())
    }
    fn push_frame(&mut self, _id: &str, _rgba: &[u8], _w: u32, _h: u32) -> Result<(), VrError> {
        Ok(())
    }
    fn set_transform(
        &mut self,
        _id: &str,
        _matrix: [[f32; 4]; 3],
        _width_m: f32,
        _curvature: f32,
        _head_locked: bool,
    ) {
    }
    fn set_visible(&mut self, _id: &str, _visible: bool) {}
    fn remove(&mut self, _id: &str) {}
    fn recenter(&mut self) {}
    fn poll(&mut self) -> bool {
        true
    }
    fn shutdown(&mut self) {}
}
