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
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ,
    MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS,
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
    /// Size of the mapped view in bytes, measured at map time (`VirtualQuery`).
    /// Every slice into the region is bounds-checked against this, because all
    /// offsets/lengths come from a header *the sim writes* — a torn header (or a
    /// hostile process squatting the unsecured section name) must never be able
    /// to make us read outside the view.
    len: usize,
}

/// `true` when `off..off+len` lies inside a region of `total` bytes, with
/// overflow-safe arithmetic. Factored out of [`MappedFile::slice`] so the
/// bounds logic is unit-testable without a live mapping.
fn in_bounds(off: usize, len: usize, total: usize) -> bool {
    off.checked_add(len).is_some_and(|end| end <= total)
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

            // Measure the actual size of the mapped view so slices can be
            // bounds-checked. Mapping with length 0 maps the whole section, but
            // nothing reports its size back — `VirtualQuery` on the view base
            // does (`RegionSize` = committed bytes from the base).
            let mut mbi = MEMORY_BASIC_INFORMATION::default();
            let queried = VirtualQuery(
                Some(view.Value as *const _),
                &mut mbi,
                std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
            );
            if queried == 0 || mbi.RegionSize == 0 {
                let _ = UnmapViewOfFile(view);
                let _ = CloseHandle(mapping);
                return Err(ConnectError::Os("VirtualQuery on mapped view failed".into()));
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
                len: mbi.RegionSize,
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

    /// Borrow `len` bytes starting at `off` within the mapped region, or `None`
    /// when the range falls outside the mapped view. Offsets/lengths come from
    /// the sim-written header, which can be torn (or hostile), so they are
    /// validated here rather than trusted.
    pub fn slice(&self, off: usize, len: usize) -> Option<&[u8]> {
        if !in_bounds(off, len, self.len) {
            return None;
        }
        // SAFETY: `off + len <= self.len` (checked above, overflow-safe), and
        // `base..base+len` stays mapped for the lifetime of `self`.
        Some(unsafe { std::slice::from_raw_parts(self.base.add(off), len) })
    }
}

#[cfg(test)]
mod tests {
    use super::in_bounds;

    #[test]
    fn in_bounds_accepts_ranges_inside_the_region() {
        assert!(in_bounds(0, 0, 0));
        assert!(in_bounds(0, 112, 112));
        assert!(in_bounds(100, 12, 112));
    }

    #[test]
    fn in_bounds_rejects_ranges_past_the_end() {
        assert!(!in_bounds(0, 113, 112));
        assert!(!in_bounds(112, 1, 112));
        assert!(!in_bounds(1_000_000, 4, 112));
    }

    #[test]
    fn in_bounds_rejects_overflowing_ranges() {
        // A negative i32 offset naively cast to usize sign-extends to ~1.8e19;
        // `off + len` must not wrap around and look valid.
        assert!(!in_bounds(usize::MAX, 4, 112));
        assert!(!in_bounds(usize::MAX - 1, usize::MAX, 112));
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
