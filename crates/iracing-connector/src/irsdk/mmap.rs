//! Win32 shared-memory + event access for the iRacing SDK region.
//!
//! ─────────────────────────────────────────────────────────────────────────
//! NOTE: All version-sensitive `windows`-crate FFI is deliberately confined to
//! this one file, targeting `windows = "0.59"`. If a future toolchain pass turns
//! up a signature mismatch (windows-rs reshapes `BOOL`/`Param` bounds between
//! minor versions), this is the only place that needs touching. The rest of the
//! crate is plain safe Rust over `&[u8]`.
//! ─────────────────────────────────────────────────────────────────────────
//!
//! Why the `windows` crate rather than `memmap2`: the iRacing region is a *named*
//! shared-memory object (`Local\\...`), not a file on disk, so we open it with
//! `OpenFileMappingW` + `MapViewOfFile` directly. `memmap2` targets file-backed
//! maps and doesn't cover named mappings cleanly. (This is the §5 "implement a
//! thin reader" path; documented here as a small, intentional deviation from the
//! "memmap2" suggestion in favor of correctness.)

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows::Win32::System::Threading::{
    OpenEventW, WaitForSingleObject, SYNCHRONIZATION_ACCESS_RIGHTS,
};

use overlay_core::ConnectError;

/// `SYNCHRONIZE` standard access right (defined locally to avoid import churn
/// across windows-rs versions).
const SYNCHRONIZE: u32 = 0x0010_0000;

/// Result of waiting on the data-ready event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitResult {
    /// A fresh frame is ready.
    Signaled,
    /// Timed out — no new frame within the budget.
    Timeout,
    /// No event handle (we'll fall back to header tick-count polling).
    NoEvent,
}

/// An open, mapped view of the iRacing shared-memory region plus its
/// data-ready event.
pub struct MappedFile {
    mapping: HANDLE,
    event: Option<HANDLE>,
    base: *const u8,
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

impl MappedFile {
    /// Open the named mapping `map_name` and the data-ready event `event_name`.
    /// Returns [`ConnectError::NotRunning`] if the mapping isn't present (sim not
    /// running). The event is optional; if it can't be opened we degrade to
    /// header-polling rather than failing.
    pub fn open(map_name: &str, event_name: &str) -> Result<Self, ConnectError> {
        let map_w = wide(map_name);
        let evt_w = wide(event_name);

        // SAFETY: standard Win32 open/map calls with valid, NUL-terminated names.
        unsafe {
            let mapping = OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(map_w.as_ptr()))
                .map_err(|_| ConnectError::NotRunning)?;

            let view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
            if view.Value.is_null() {
                let _ = CloseHandle(mapping);
                return Err(ConnectError::Os("MapViewOfFile returned null".into()));
            }

            // The data-ready event is best-effort.
            let event = OpenEventW(
                SYNCHRONIZATION_ACCESS_RIGHTS(SYNCHRONIZE),
                false,
                PCWSTR(evt_w.as_ptr()),
            )
            .ok();

            Ok(MappedFile {
                mapping,
                event,
                base: view.Value as *const u8,
            })
        }
    }

    // Exposed for the perf HUD / diagnostics (Phase 2): are we event-driven or
    // falling back to polling?
    #[allow(dead_code)]
    pub fn has_event(&self) -> bool {
        self.event.is_some()
    }

    /// Wait up to `timeout_ms` for the sim to signal a new frame.
    ///
    /// The event is auto-reset, so a successful wait consumes the signal. If we
    /// have no event handle we report [`WaitResult::NoEvent`] and the caller
    /// polls the header tick-count instead.
    pub fn wait_for_data(&self, timeout_ms: u32) -> WaitResult {
        match self.event {
            None => WaitResult::NoEvent,
            // SAFETY: `event` is a valid handle we own for the lifetime of self.
            Some(event) => unsafe {
                if WaitForSingleObject(event, timeout_ms) == WAIT_OBJECT_0 {
                    WaitResult::Signaled
                } else {
                    WaitResult::Timeout
                }
            },
        }
    }

    /// Borrow `len` bytes starting at `off` within the mapped region.
    ///
    /// # Safety
    /// `off + len` must lie within the region the sim allocated. Callers derive
    /// these bounds from the header the sim itself wrote, so in practice they do.
    pub unsafe fn slice(&self, off: usize, len: usize) -> &[u8] {
        std::slice::from_raw_parts(self.base.add(off), len)
    }
}

impl Drop for MappedFile {
    fn drop(&mut self) {
        // SAFETY: we created these handles/mapping in `open` and own them.
        unsafe {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.base as *mut _,
            });
            if let Some(event) = self.event {
                let _ = CloseHandle(event);
            }
            let _ = CloseHandle(self.mapping);
        }
    }
}
