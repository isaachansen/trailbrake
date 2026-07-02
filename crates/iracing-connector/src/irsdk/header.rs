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
    /// Parse the header prefix. Returns `None` if the slice is too short **or
    /// any sim-written length/offset is negative** — a negative value means a
    /// torn header (sim starting up / crashing) or garbage from a foreign
    /// process, and naively casting it to `usize` would sign-extend into an
    /// enormous offset. Callers treat `None` as "not ready this poll".
    pub fn parse(region: &[u8]) -> Option<Self> {
        if region.len() < HEADER_LEN {
            return None;
        }
        // Negative length/offset → torn/garbage header.
        let nonneg = |off: usize| usize::try_from(i32_at(region, off)).ok();

        let num_buf = nonneg(32)?.min(MAX_BUFS);
        let mut var_bufs = [VarBuf {
            tick_count: 0,
            buf_offset: 0,
        }; MAX_BUFS];
        for (i, vb) in var_bufs.iter_mut().enumerate().take(num_buf) {
            // Entries beyond `num_buf` are unused by the sim and may hold
            // garbage, so only the active ones are validated.
            let base = 48 + i * VAR_BUF_LEN;
            vb.tick_count = i32_at(region, base);
            vb.buf_offset = usize::try_from(i32_at(region, base + 4)).ok()?;
        }

        Some(Header {
            ver: i32_at(region, 0),
            status: i32_at(region, 4),
            tick_rate: i32_at(region, 8),
            session_info_update: i32_at(region, 12),
            session_info_len: nonneg(16)?,
            session_info_offset: nonneg(20)?,
            num_vars: nonneg(24)?,
            var_header_offset: nonneg(28)?,
            num_buf,
            buf_len: nonneg(36)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a plausible 112-byte header region: connected, 1 buffer.
    fn region() -> Vec<u8> {
        let mut r = vec![0u8; HEADER_LEN];
        let put = |r: &mut Vec<u8>, off: usize, v: i32| {
            r[off..off + 4].copy_from_slice(&v.to_le_bytes());
        };
        put(&mut r, 0, 2); // ver
        put(&mut r, 4, 1); // status: connected
        put(&mut r, 8, 60); // tickRate
        put(&mut r, 12, 7); // sessionInfoUpdate
        put(&mut r, 16, 1024); // sessionInfoLen
        put(&mut r, 20, 4096); // sessionInfoOffset
        put(&mut r, 24, 300); // numVars
        put(&mut r, 28, 144); // varHeaderOffset
        put(&mut r, 32, 1); // numBuf
        put(&mut r, 36, 6000); // bufLen
        put(&mut r, 48, 12345); // varBuf[0].tickCount
        put(&mut r, 52, 65536); // varBuf[0].bufOffset
        r
    }

    #[test]
    fn parses_a_well_formed_header() {
        let h = Header::parse(&region()).expect("valid header");
        assert_eq!(h.session_info_update, 7);
        assert_eq!(h.num_vars, 300);
        assert_eq!(h.buf_len, 6000);
        assert_eq!(h.latest_buf().buf_offset, 65536);
    }

    #[test]
    fn rejects_short_region() {
        assert!(Header::parse(&region()[..HEADER_LEN - 1]).is_none());
    }

    #[test]
    fn rejects_negative_lengths_and_offsets() {
        // Each of the sim-written length/offset fields, poisoned in turn, must
        // fail the parse instead of sign-extending to a huge usize.
        for off in [16usize, 20, 24, 28, 32, 36] {
            let mut r = region();
            r[off..off + 4].copy_from_slice(&(-1i32).to_le_bytes());
            assert!(Header::parse(&r).is_none(), "field at {off} accepted -1");
        }
    }

    #[test]
    fn rejects_negative_active_buf_offset() {
        let mut r = region();
        r[52..56].copy_from_slice(&(-4i32).to_le_bytes());
        assert!(Header::parse(&r).is_none());
    }

    #[test]
    fn ignores_garbage_in_inactive_buf_slots() {
        // numBuf = 1, so slots 1..4 may legitimately hold junk.
        let mut r = region();
        r[64..68].copy_from_slice(&(-1i32).to_le_bytes()); // varBuf[1].tickCount
        r[68..72].copy_from_slice(&(-1i32).to_le_bytes()); // varBuf[1].bufOffset
        assert!(Header::parse(&r).is_some());
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
