//! VR compositor for the Trailbrake overlay.
//!
//! The desktop overlay paints widgets onto a transparent, always-on-top window
//! that sits over the game on a monitor. In VR that window is never seen — the
//! sim renders straight to the headset. This crate re-composites the widgets
//! *into* the VR scene: it captures the overlay window, slices out each widget by
//! its on-screen rectangle, and draws each one as its own floating panel (an
//! OpenVR "overlay" quad) positioned in the cockpit. A widget's spot on the flat
//! overlay maps to the same angular spot in VR, so arranging widgets in the 2-D
//! editor arranges them in VR — they stay spread out, not clumped.
//!
//! # Backends
//!
//! - **OpenVR (SteamVR)** — the working path. SteamVR is the only runtime that
//!   composites a foreign overlay on top of a running sim today. Enabled with the
//!   `openvr` feature.
//! - **OpenXR** — best-effort, behind the `openxr` feature. The overlay
//!   extension (`XR_EXTX_overlay`) is provisional and unimplemented by SteamVR,
//!   WMR, and Meta runtimes, so this backend reports [`VrError::Unsupported`] on
//!   real hardware and the caller falls back to OpenVR. The composition path is
//!   written but currently unexercisable (see `openxr.rs`).
//!
//! # Build
//!
//! VR support is **opt-in** via the `vr` feature (`openvr` + `openxr`). The
//! default build pulls no VR dependencies and compiles the [`VrManager`] to a
//! no-op that reports "unavailable" — so the rest of the app builds anywhere
//! without a VR toolchain. The real build additionally requires:
//!
//! - **LLVM / libclang** — `ovr_overlay` binds OpenVR through `autocxx`.
//! - **A C++ toolchain + Windows SDK** — for the bindings and Windows Graphics
//!   Capture.
//! - At runtime, `openvr_api.dll` must be loadable (SteamVR ships it; we also
//!   bundle it next to the executable). The OpenXR loader is loaded dynamically,
//!   so a missing runtime is a graceful error rather than a link failure.

mod transform;
pub use transform::panel_transform;

use serde::{Deserialize, Serialize};

/// One widget to mirror into VR. Pixel rectangle is in the captured overlay
/// window's physical-pixel coordinate space (CSS px × the webview scale factor),
/// matching what Windows Graphics Capture returns.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VrWidget {
    /// Stable widget instance id (used as the overlay key, so panels persist
    /// across layout updates).
    pub id: String,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// Per-widget depth offset in metres, added to the global distance so a
    /// widget can be pushed nearer or farther than the rest. 0 = on the ring.
    pub depth_m: f32,
}

/// Global VR placement controls, shared by every panel.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VrGlobals {
    /// Distance from the viewer to the ring the panels sit on, in metres.
    pub distance_m: f32,
    /// Overall size multiplier for every panel.
    pub scale: f32,
    /// 0 = flat quads, 1 = fully cylindrical (panels curve toward the viewer).
    pub curvature: f32,
    /// World/seated-locked (false, default — panels stay put as you look around)
    /// vs head-locked (true — panels follow your view).
    pub head_locked: bool,
}

impl Default for VrGlobals {
    fn default() -> Self {
        Self {
            distance_m: 0.9,
            scale: 1.0,
            curvature: 0.15,
            head_locked: false,
        }
    }
}

/// Which backend to prefer when starting. `Auto` tries OpenVR, then OpenXR.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Auto,
    OpenVr,
    OpenXr,
}

impl Default for BackendKind {
    fn default() -> Self {
        BackendKind::Auto
    }
}

/// Snapshot of the compositor state for the manager status line.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VrStatus {
    /// A VR backend is compiled in and a runtime is reachable.
    pub available: bool,
    /// The compositor is running and pushing frames.
    pub active: bool,
    /// Human-readable backend name ("OpenVR", "OpenXR", or "none").
    pub backend: String,
    /// Last status / error message for display.
    pub message: String,
}

impl VrStatus {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            available: false,
            active: false,
            backend: "none".into(),
            message: message.into(),
        }
    }
}

/// Errors from starting or driving the compositor.
#[derive(Debug, Clone)]
pub enum VrError {
    /// No VR backend was compiled in (built without the `vr` feature) or the
    /// platform isn't supported.
    Unavailable(String),
    /// A backend is compiled in but the runtime can't service this request
    /// (e.g. OpenXR without `XR_EXTX_overlay`, or SteamVR not running).
    Unsupported(String),
    /// The runtime returned an error.
    Runtime(String),
}

impl std::fmt::Display for VrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VrError::Unavailable(m) => write!(f, "VR unavailable: {m}"),
            VrError::Unsupported(m) => write!(f, "VR unsupported: {m}"),
            VrError::Runtime(m) => write!(f, "VR runtime error: {m}"),
        }
    }
}

impl std::error::Error for VrError {}

/// `true` when a real VR backend is compiled in for this target. (Whether a
/// runtime is actually *reachable* is only known once [`VrManager::start`] runs.)
pub const fn compiled_in() -> bool {
    cfg!(all(
        windows,
        any(feature = "openvr", feature = "openxr")
    ))
}

// Select the real implementation (Windows + a backend feature) or the stub.
#[cfg(all(windows, any(feature = "openvr", feature = "openxr")))]
mod backend;
// Capture also compiles under the internal `_wgc_check` feature so the Windows
// Graphics Capture code can be verified without the libclang-gated OpenVR dep.
#[cfg(all(
    windows,
    any(feature = "openvr", feature = "openxr", feature = "_wgc_check")
))]
mod capture;
#[cfg(all(windows, any(feature = "openvr", feature = "openxr")))]
mod imp;

#[cfg(all(windows, feature = "openvr"))]
mod openvr;
#[cfg(all(windows, feature = "openxr"))]
mod openxr;

#[cfg(not(all(windows, any(feature = "openvr", feature = "openxr"))))]
#[path = "stub.rs"]
mod imp;

pub use imp::VrManager;
