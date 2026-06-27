//! The real [`VrManager`] (Windows + a backend feature): owns a render thread
//! that captures the overlay window, slices out each widget, and pushes it to a
//! per-widget panel through the active [`VrBackend`].

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::backend::VrBackend;
use crate::capture::Capturer;
use crate::transform::panel_transform;
use crate::{BackendKind, VrError, VrGlobals, VrStatus, VrWidget};

/// Render at ~30 Hz — plenty for telemetry panels, easy on the GPU/CPU.
const FRAME_INTERVAL: Duration = Duration::from_millis(33);

struct Shared {
    layout: Mutex<Vec<VrWidget>>,
    globals: Mutex<VrGlobals>,
    status: Mutex<VrStatus>,
    stop: AtomicBool,
    recenter: AtomicBool,
}

pub struct VrManager {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl VrManager {
    pub fn start(hwnd: isize, prefer: BackendKind, globals: VrGlobals) -> Result<Self, VrError> {
        let shared = Arc::new(Shared {
            layout: Mutex::new(Vec::new()),
            globals: Mutex::new(globals),
            status: Mutex::new(VrStatus {
                available: true,
                active: false,
                backend: "none".into(),
                message: "starting".into(),
            }),
            stop: AtomicBool::new(false),
            recenter: AtomicBool::new(false),
        });

        // The backend and capturer wrap `!Send` COM objects, so they're created
        // and used entirely on the render thread. We report the init outcome back
        // over a channel so `start` can surface "SteamVR not running" etc.
        // synchronously to the caller.
        let (init_tx, init_rx) = mpsc::channel::<Result<String, VrError>>();
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("vr-compositor".into())
            .spawn(move || {
                let init = (|| -> Result<(Box<dyn VrBackend>, Capturer), VrError> {
                    let backend = make_backend(prefer)?;
                    let capturer = Capturer::new(hwnd)?;
                    Ok((backend, capturer))
                })();
                match init {
                    Err(e) => {
                        let _ = init_tx.send(Err(e));
                    }
                    Ok((mut backend, mut capturer)) => {
                        let name = backend.name().to_string();
                        let _ = init_tx.send(Ok(name));
                        render_loop(thread_shared, backend.as_mut(), &mut capturer);
                        backend.shutdown();
                    }
                }
            })
            .map_err(|e| VrError::Runtime(format!("spawn vr thread: {e}")))?;

        match init_rx.recv() {
            Ok(Ok(name)) => {
                let mut st = shared.status.lock().unwrap();
                st.active = true;
                st.backend = name.clone();
                st.message = format!("{name} active");
                drop(st);
                Ok(Self {
                    shared,
                    thread: Some(thread),
                })
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(VrError::Runtime("vr thread exited during init".into()))
            }
        }
    }

    pub fn set_layout(&self, widgets: Vec<VrWidget>) {
        *self.shared.layout.lock().unwrap() = widgets;
    }

    pub fn set_globals(&self, globals: VrGlobals) {
        *self.shared.globals.lock().unwrap() = globals;
    }

    pub fn recenter(&self) {
        self.shared.recenter.store(true, Ordering::SeqCst);
    }

    pub fn status(&self) -> VrStatus {
        self.shared.status.lock().unwrap().clone()
    }

    pub fn stop(mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for VrManager {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn render_loop(shared: Arc<Shared>, backend: &mut dyn VrBackend, capturer: &mut Capturer) {
    let mut live: HashSet<String> = HashSet::new();

    while !shared.stop.load(Ordering::SeqCst) {
        if shared.recenter.swap(false, Ordering::SeqCst) {
            backend.recenter();
        }

        let globals = *shared.globals.lock().unwrap();
        let widgets = shared.layout.lock().unwrap().clone();

        // Pull the latest frame. A miss (no new frame yet) just skips this tick.
        match capturer.frame() {
            Ok(Some(frame)) => {
                let mut seen: HashSet<String> = HashSet::new();
                for w in &widgets {
                    seen.insert(w.id.clone());
                    if backend.ensure_overlay(&w.id).is_err() {
                        continue;
                    }
                    if let Some((data, cw, ch)) = crop_rgba(&frame, w) {
                        let _ = backend.push_frame(&w.id, &data, cw, ch);

                        let fw = frame.width.max(1) as f32;
                        let fh = frame.height.max(1) as f32;
                        let cx = (w.x as f32 + w.w as f32 * 0.5) / fw;
                        let cy = (w.y as f32 + w.h as f32 * 0.5) / fh;
                        let frac_w = w.w as f32 / fw;
                        let pose = panel_transform(
                            cx,
                            cy,
                            frac_w,
                            globals.distance_m + w.depth_m,
                            globals.scale,
                        );
                        backend.set_transform(
                            &w.id,
                            pose.matrix,
                            pose.width_m,
                            globals.curvature,
                            globals.head_locked,
                        );
                        backend.set_visible(&w.id, true);
                    }
                }
                // Retire panels no longer in the layout.
                for id in live.difference(&seen).cloned().collect::<Vec<_>>() {
                    backend.remove(&id);
                }
                live = seen;
            }
            Ok(None) => {}
            Err(e) => {
                if let Ok(mut st) = shared.status.lock() {
                    st.message = format!("capture error: {e}");
                }
            }
        }

        if !backend.poll() {
            break;
        }
        std::thread::sleep(FRAME_INTERVAL);
    }

    if let Ok(mut st) = shared.status.lock() {
        st.active = false;
        st.message = "stopped".into();
    }
}

/// Crop a widget's rectangle out of a captured BGRA frame and convert it to the
/// RGBA layout OpenVR's `SetOverlayRaw` expects. Returns `None` if the rect is
/// fully outside the frame.
fn crop_rgba(frame: &crate::capture::Frame, w: &VrWidget) -> Option<(Vec<u8>, u32, u32)> {
    let fw = frame.width;
    let fh = frame.height;
    if w.x >= fw || w.y >= fh || w.w == 0 || w.h == 0 {
        return None;
    }
    let cw = w.w.min(fw - w.x);
    let ch = w.h.min(fh - w.y);
    let mut out = vec![0u8; (cw * ch * 4) as usize];
    let src = &frame.data;
    let stride = (fw * 4) as usize;
    for row in 0..ch {
        let src_row = ((w.y + row) * fw + w.x) as usize * 4;
        let dst_row = (row * cw) as usize * 4;
        for col in 0..cw as usize {
            let s = src_row + col * 4;
            let d = dst_row + col * 4;
            // BGRA -> RGBA
            out[d] = src[s + 2];
            out[d + 1] = src[s + 1];
            out[d + 2] = src[s];
            out[d + 3] = src[s + 3];
        }
    }
    Some((out, cw, ch))
}

/// Pick a backend, honouring the preference and falling back where it makes
/// sense (OpenXR is best-effort and falls back to OpenVR when the runtime lacks
/// the overlay extension).
fn make_backend(prefer: BackendKind) -> Result<Box<dyn VrBackend>, VrError> {
    match prefer {
        BackendKind::OpenVr => open_vr(),
        BackendKind::OpenXr => open_xr().or_else(|e| {
            // Best-effort: fall back to the working backend if it's compiled in.
            match open_vr() {
                Ok(b) => Ok(b),
                Err(_) => Err(e),
            }
        }),
        BackendKind::Auto => match open_vr() {
            Ok(b) => Ok(b),
            Err(first) => open_xr().map_err(|_| first),
        },
    }
}

#[cfg(feature = "openvr")]
fn open_vr() -> Result<Box<dyn VrBackend>, VrError> {
    Ok(Box::new(crate::openvr::OpenVrBackend::new()?))
}
#[cfg(not(feature = "openvr"))]
fn open_vr() -> Result<Box<dyn VrBackend>, VrError> {
    Err(VrError::Unavailable("OpenVR backend not compiled in".into()))
}

#[cfg(feature = "openxr")]
fn open_xr() -> Result<Box<dyn VrBackend>, VrError> {
    Ok(Box::new(crate::openxr::OpenXrBackend::new()?))
}
#[cfg(not(feature = "openxr"))]
fn open_xr() -> Result<Box<dyn VrBackend>, VrError> {
    Err(VrError::Unavailable("OpenXR backend not compiled in".into()))
}
