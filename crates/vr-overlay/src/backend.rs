//! The backend seam: one concrete implementation per runtime (OpenVR, OpenXR).
//! [`crate::imp::VrManager`] owns a `Box<dyn VrBackend>` on its render thread and
//! drives it; the backends never touch capture, layout, or threading.

use crate::{VrError, VrWidget};

/// A live VR runtime connection that can host one floating panel per widget.
///
/// Implementations are created and used entirely on the render thread, so they
/// need not be `Sync`; `Send` lets us construct the backend after the thread
/// spawns (some runtimes pin to the creating thread).
pub trait VrBackend: Send {
    /// Human-readable name for the status line.
    fn name(&self) -> &'static str;

    /// Create the overlay for `id` if it doesn't exist yet. Idempotent.
    fn ensure_overlay(&mut self, id: &str) -> Result<(), VrError>;

    /// Upload an RGBA frame (`w`×`h`, 4 bytes/pixel, row-major top-down) as the
    /// panel's texture.
    fn push_frame(&mut self, id: &str, rgba: &[u8], w: u32, h: u32) -> Result<(), VrError>;

    /// Position/size the panel. `matrix` is a row-major 3×4 transform in the
    /// runtime's tracking space; `width_m` is the panel width in metres;
    /// `curvature` in `[0,1]`; `head_locked` chooses head- vs world-locked space.
    fn set_transform(
        &mut self,
        id: &str,
        matrix: [[f32; 4]; 3],
        width_m: f32,
        curvature: f32,
        head_locked: bool,
    );

    fn set_visible(&mut self, id: &str, visible: bool);

    /// Drop a panel that's no longer in the layout (hidden if the runtime can't
    /// destroy mid-session).
    fn remove(&mut self, id: &str);

    /// Re-snapshot the "straight ahead" origin (best-effort; see backend docs).
    fn recenter(&mut self);

    /// Pump runtime events (quit/recenter requests, etc.). Return `false` to ask
    /// the manager to stop (runtime is shutting down).
    fn poll(&mut self) -> bool;

    fn shutdown(&mut self);
}
