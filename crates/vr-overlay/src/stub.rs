//! No-op [`VrManager`] used whenever a real VR backend isn't compiled in (any
//! non-Windows target, or a build without the `openvr`/`openxr` features).
//!
//! It mirrors the real manager's public surface so `src-tauri` calls the same
//! API unconditionally; every call is inert and [`VrManager::start`] fails with
//! [`VrError::Unavailable`], which the manager surfaces as "VR not available".

use crate::{BackendKind, VrError, VrGlobals, VrStatus, VrWidget};

/// Stub compositor handle — never actually constructed (start always errors).
pub struct VrManager {
    _private: (),
}

impl VrManager {
    /// Always fails: this build has no VR backend.
    pub fn start(_hwnd: isize, _prefer: BackendKind, _globals: VrGlobals) -> Result<Self, VrError> {
        Err(VrError::Unavailable(
            "built without VR support (enable the `vr` feature on Windows)".into(),
        ))
    }

    pub fn set_layout(&self, _widgets: Vec<VrWidget>) {}
    pub fn set_globals(&self, _globals: VrGlobals) {}
    pub fn recenter(&self) {}

    pub fn status(&self) -> VrStatus {
        VrStatus::unavailable("VR not available in this build")
    }

    pub fn stop(self) {}
}
