//! Win32 named shared-memory access for the rF2 plugin mappings.
//!
//! ─────────────────────────────────────────────────────────────────────────
//! NOTE: All `windows`-crate FFI is deliberately confined to this one file,
//! targeting `windows = "0.59"` (same as the iRacing reader). The rest of the
//! crate is plain safe Rust over `&[u8]`.
//! ─────────────────────────────────────────────────────────────────────────
//!
//! Unlike iRacing, the rF2 plugin publishes **no data-ready event** — it is
//! poll-based. Coherency comes from the 8-byte version block at the head of each
//! mapping (`mVersionUpdateBegin` / `mVersionUpdateEnd`): a frame is torn if the
//! two disagree, or if `begin` moves while we copy. [`MappedRegion::copy_frame`]
//! implements that guard, returning the copied bytes plus the coherent version.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ,
    MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS,
};

use overlay_core::ConnectError;

use super::{VERSION_BEGIN, VERSION_END};

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// `true` when `off..off+len` lies inside `total` bytes, overflow-safe.
fn in_bounds(off: usize, len: usize, total: usize) -> bool {
    off.checked_add(len).is_some_and(|end| end <= total)
}

/// Read a little-endian u32 from a raw region slice, bounds-checked.
fn read_u32(base: *const u8, len: usize, off: usize) -> Option<u32> {
    if !in_bounds(off, 4, len) {
        return None;
    }
    // SAFETY: `off + 4 <= len`, so these 4 bytes are inside the mapped view.
    let mut b = [0u8; 4];
    unsafe {
        std::ptr::copy_nonoverlapping(base.add(off), b.as_mut_ptr(), 4);
    }
    Some(u32::from_le_bytes(b))
}

/// An open, mapped, read-only view of one rF2 named mapping.
pub struct MappedRegion {
    mapping: HANDLE,
    base: *const u8,
    /// Size of the mapped view (measured with `VirtualQuery` at map time). Every
    /// read is bounds-checked against this.
    len: usize,
}

impl MappedRegion {
    /// Open the named mapping `map_name`. Returns [`ConnectError::NotRunning`]
    /// when the mapping is absent — i.e. LMU isn't running, or the shared-memory
    /// plugin isn't installed/enabled.
    pub fn open(map_name: &str) -> Result<Self, ConnectError> {
        let name_w = wide(map_name);
        // SAFETY: standard Win32 open/map with a valid NUL-terminated name.
        unsafe {
            let mapping = OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name_w.as_ptr()))
                .map_err(|_| ConnectError::NotRunning)?;

            let view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
            if view.Value.is_null() {
                let _ = CloseHandle(mapping);
                return Err(ConnectError::Os("MapViewOfFile returned null".into()));
            }

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

            Ok(MappedRegion {
                mapping,
                base: view.Value as *const u8,
                len: mbi.RegionSize,
            })
        }
    }

    /// Size of the mapped view in bytes (for diagnostics).
    pub fn len(&self) -> usize {
        self.len
    }

    /// The current `mVersionUpdateEnd` counter, or `None` if unreadable.
    pub fn version(&self) -> Option<u32> {
        read_u32(self.base, self.len, VERSION_END)
    }

    /// Copy a coherent frame into `scratch`, returning its version
    /// (`mVersionUpdateEnd`).
    ///
    /// Retries a few times if the plugin is mid-write: the frame is rejected
    /// when `begin != end` before the copy, or when `begin` advances across it.
    /// Returns `None` if we never caught a clean frame (extremely rare) or the
    /// region is too small to hold the version block.
    pub fn copy_frame(&self, scratch: &mut Vec<u8>) -> Option<u32> {
        for _ in 0..8 {
            let begin = read_u32(self.base, self.len, VERSION_BEGIN)?;
            let end = read_u32(self.base, self.len, VERSION_END)?;
            if begin != end {
                // Write in progress; let it finish.
                std::hint::spin_loop();
                continue;
            }

            scratch.clear();
            scratch.reserve(self.len);
            // SAFETY: `base..base+len` stays mapped for the lifetime of `self`;
            // `len` is the measured view size.
            unsafe {
                let src = std::slice::from_raw_parts(self.base, self.len);
                scratch.extend_from_slice(src);
            }

            // If `begin` moved while we copied, the copy straddled a write.
            let begin_after = read_u32(self.base, self.len, VERSION_BEGIN)?;
            if begin_after == begin {
                return Some(end);
            }
        }
        None
    }
}

// SAFETY: `MappedRegion` holds a raw pointer into the mapped view, making it
// `!Send` by default. The reader thread owns the connector (and thus its
// regions) exclusively after a single move and never shares it, so marking it
// `Send` is sound — same argument as the iRacing connector.
unsafe impl Send for MappedRegion {}

impl Drop for MappedRegion {
    fn drop(&mut self) {
        // SAFETY: we created the mapping/view in `open` and own them.
        unsafe {
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.base as *mut _,
            });
            let _ = CloseHandle(self.mapping);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::in_bounds;

    #[test]
    fn in_bounds_matches_iracing_reader() {
        assert!(in_bounds(0, 8, 8));
        assert!(!in_bounds(4, 8, 8));
        assert!(!in_bounds(usize::MAX, 4, 100));
    }
}
