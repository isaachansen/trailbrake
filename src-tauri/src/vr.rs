//! VR bridge: exposes the `vr-overlay` compositor to the manager webview.
//!
//! The heavy lifting (capture, OpenVR/OpenXR panels) lives in the `vr-overlay`
//! crate; this module owns the live [`VrManager`] in Tauri state and surfaces a
//! few commands. Without the `vr` feature (or off Windows) `vr-overlay` is a
//! no-op stub, so every command still works and simply reports "unavailable".
//!
//! When VR is active the overlay window is force-shown (parked on its monitor) so
//! Windows Graphics Capture has something to read — the user is in the headset,
//! not looking at the desktop.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use vr_overlay::{BackendKind, VrGlobals, VrManager, VrStatus, VrWidget};

pub const EVT_VR_STATUS: &str = "overlay://vr-status";

/// Live compositor handle (None when VR is off).
#[derive(Default)]
pub struct VrState {
    pub manager: Mutex<Option<VrManager>>,
}

/// Native handle of the overlay window, as an `isize` the compositor can use.
#[cfg(windows)]
fn overlay_hwnd(app: &AppHandle) -> Result<isize, String> {
    let win = app
        .get_webview_window("overlay")
        .ok_or("no overlay window")?;
    let hwnd = win.hwnd().map_err(|e| e.to_string())?;
    Ok(hwnd.0 as isize)
}
#[cfg(not(windows))]
fn overlay_hwnd(_app: &AppHandle) -> Result<isize, String> {
    Ok(0)
}

fn current_status(app: &AppHandle) -> VrStatus {
    let st = app.state::<VrState>();
    let guard = st.manager.lock().unwrap();
    match guard.as_ref() {
        Some(m) => m.status(),
        None => {
            if vr_overlay::compiled_in() {
                VrStatus::unavailable("VR off")
            } else {
                VrStatus::unavailable("built without VR support (build with --features vr on Windows)")
            }
        }
    }
}

#[tauri::command]
pub fn vr_status(app: AppHandle) -> VrStatus {
    current_status(&app)
}

#[tauri::command]
pub fn vr_set_enabled(
    app: AppHandle,
    enabled: bool,
    backend: Option<BackendKind>,
    globals: Option<VrGlobals>,
) -> Result<VrStatus, String> {
    let st = app.state::<VrState>();
    if enabled {
        let already = st.manager.lock().unwrap().is_some();
        if !already {
            let hwnd = overlay_hwnd(&app)?;
            let g = globals.unwrap_or_default();
            let kind = backend.unwrap_or_default();
            // Force the overlay window visible *before* starting so capture has a
            // rendered window to read.
            crate::set_vr_active(&app, true);
            match VrManager::start(hwnd, kind, g) {
                Ok(m) => {
                    *st.manager.lock().unwrap() = Some(m);
                }
                Err(e) => {
                    crate::set_vr_active(&app, false);
                    let _ = app.emit(EVT_VR_STATUS, VrStatus::unavailable(e.to_string()));
                    return Err(e.to_string());
                }
            }
        }
    } else {
        if let Some(m) = st.manager.lock().unwrap().take() {
            m.stop();
        }
        crate::set_vr_active(&app, false);
    }
    let status = current_status(&app);
    let _ = app.emit(EVT_VR_STATUS, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn vr_set_layout(app: AppHandle, widgets: Vec<VrWidget>) {
    let st = app.state::<VrState>();
    let guard = st.manager.lock().unwrap();
    if let Some(m) = guard.as_ref() {
        m.set_layout(widgets);
    }
}

#[tauri::command]
pub fn vr_set_globals(app: AppHandle, globals: VrGlobals) {
    let st = app.state::<VrState>();
    let guard = st.manager.lock().unwrap();
    if let Some(m) = guard.as_ref() {
        m.set_globals(globals);
    }
}

#[tauri::command]
pub fn vr_recenter(app: AppHandle) {
    let st = app.state::<VrState>();
    let guard = st.manager.lock().unwrap();
    if let Some(m) = guard.as_ref() {
        m.recenter();
    }
}
