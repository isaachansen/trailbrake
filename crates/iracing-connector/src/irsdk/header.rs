//! Parsing of the irsdk header and variable-header table.
//!
//! We read fields out of `&[u8]` by explicit little-endian offset rather than
//! casting structs, so this is robust to alignment and never aliases the mapped
//! memory unsafely.

use std::collections::HashMap;

use super::var::{VarDef, VarType};
use super::{HEADER_LEN, MAX_BUFS, MAX_STRING, VAR_BUF_LEN, VAR_HEADER_LEN};

fn i32_at(buf: &[u8], off: usize) -> i32 {
    i32::from_le_bytes(buf[off..off + 4].try_into().unwrap())
}

/// One rotating telemetry buffer descriptor.
#[derive(Clone, Copy, Debug)]
pub struct VarBuf {
    pub tick_count: i32,
    /// Offset of this buffer's row from the start of the mapped region.
    pub buf_offset: usize,
}

/// The parsed irsdk header (the small fixed-size prefix of the region).
#[derive(Clone, Debug)]
pub struct Header {
    // `ver`/`tick_rate` are surfaced for the perf HUD (Phase 2/3); parsed now so
    // the layout stays in one place.
    #[allow(dead_code)]
    pub ver: i32,
    pub status: i32,
    #[allow(dead_code)]
    pub tick_rate: i32,
    pub session_info_update: i32,
    pub session_info_len: usize,
    pub session_info_offset: usize,
    pub num_vars: usize,
    pub var_header_offset: usize,
    pub num_buf: usize,
    pub buf_len: usize,
    pub var_bufs: [VarBuf; MAX_BUFS],
}

impl Header {
    /// Parse the header prefix. Returns `None` if the slice is too short.
    pub fn parse(region: &[u8]) -> Option<Self> {
        if region.len() < HEADER_LEN {
            return None;
        }
        let mut var_bufs = [VarBuf {
            tick_count: 0,
            buf_offset: 0,
        }; MAX_BUFS];
        for (i, vb) in var_bufs.iter_mut().enumerate() {
            let base = 48 + i * VAR_BUF_LEN;
            vb.tick_count = i32_at(region, base);
            vb.buf_offset = i32_at(region, base + 4) as usize;
        }

        Some(Header {
            ver: i32_at(region, 0),
            status: i32_at(region, 4),
            tick_rate: i32_at(region, 8),
            session_info_update: i32_at(region, 12),
            session_info_len: i32_at(region, 16).max(0) as usize,
            session_info_offset: i32_at(region, 20).max(0) as usize,
            num_vars: i32_at(region, 24).max(0) as usize,
            var_header_offset: i32_at(region, 28).max(0) as usize,
            num_buf: (i32_at(region, 32).max(0) as usize).min(MAX_BUFS),
            buf_len: i32_at(region, 36).max(0) as usize,
            var_bufs,
        })
    }

    /// Index of the freshest telemetry buffer (highest `tickCount`).
    pub fn latest_buf(&self) -> &VarBuf {
        self.var_bufs[..self.num_buf]
            .iter()
            .max_by_key(|b| b.tick_count)
            .unwrap_or(&self.var_bufs[0])
    }
}

/// Read a fixed-width, NUL-padded ASCII field into a `String`.
fn read_cstr(region: &[u8], off: usize, max: usize) -> String {
    let end = (off + max).min(region.len());
    let bytes = &region[off..end];
    let len = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..len]).into_owned()
}

/// Build the `name -> VarDef` map by walking the variable-header table.
///
/// This is done **once per session** (when `sessionInfoUpdate` changes), never
/// per frame (perf non-negotiable #3).
pub fn build_var_map(region: &[u8], header: &Header) -> HashMap<String, VarDef> {
    let mut map = HashMap::with_capacity(header.num_vars);
    for i in 0..header.num_vars {
        let base = header.var_header_offset + i * VAR_HEADER_LEN;
        if base + VAR_HEADER_LEN > region.len() {
            break;
        }
        let Some(ty) = VarType::from_i32(i32_at(region, base)) else {
            continue;
        };
        let offset = i32_at(region, base + 4).max(0) as usize;
        let count = i32_at(region, base + 8).max(0) as usize;
        let name = read_cstr(region, base + 16, MAX_STRING);
        if name.is_empty() {
            continue;
        }
        map.insert(name, VarDef { ty, offset, count });
    }
    map
}
