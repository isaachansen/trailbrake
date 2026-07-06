//! Safe, bounds-checked reads over a copied rF2 buffer.
//!
//! Every offset/length is validated against the slice before reading, so a
//! torn or short buffer yields `None` rather than reading out of bounds — the
//! same posture as the iRacing reader (offsets come from memory the sim writes
//! and must never be trusted to be in range). All multi-byte values are
//! little-endian (x86).

/// Read a little-endian `f64` at `off`, or `None` if it doesn't fit.
pub fn rd_f64(buf: &[u8], off: usize) -> Option<f64> {
    let end = off.checked_add(8)?;
    let bytes = buf.get(off..end)?;
    Some(f64::from_le_bytes(bytes.try_into().ok()?))
}

/// Read a little-endian `i32` at `off`, or `None` if it doesn't fit.
pub fn rd_i32(buf: &[u8], off: usize) -> Option<i32> {
    let end = off.checked_add(4)?;
    let bytes = buf.get(off..end)?;
    Some(i32::from_le_bytes(bytes.try_into().ok()?))
}

/// Read a little-endian `u32` at `off`, or `None` if it doesn't fit.
pub fn rd_u32(buf: &[u8], off: usize) -> Option<u32> {
    let end = off.checked_add(4)?;
    let bytes = buf.get(off..end)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

/// Read a little-endian `f32` at `off`, or `None` if it doesn't fit. rF2 uses a
/// handful of `float` (not `double`) fields even under `#pragma pack(4)`
/// (e.g. `mPhysicalSteeringWheelRange`, `mPitLapDist`, `mCurrentPitSpeedLimit`).
pub fn rd_f32(buf: &[u8], off: usize) -> Option<f32> {
    let end = off.checked_add(4)?;
    let bytes = buf.get(off..end)?;
    Some(f32::from_le_bytes(bytes.try_into().ok()?))
}

/// Read a little-endian `i16` at `off`, or `None` if it doesn't fit (e.g.
/// `mTotalLaps`, `mNumPitstops`).
pub fn rd_i16(buf: &[u8], off: usize) -> Option<i16> {
    let end = off.checked_add(2)?;
    let bytes = buf.get(off..end)?;
    Some(i16::from_le_bytes(bytes.try_into().ok()?))
}

/// Read a single byte as `u8` at `off`, or `None` if out of range.
pub fn rd_u8(buf: &[u8], off: usize) -> Option<u8> {
    buf.get(off).copied()
}

/// Read a single byte as `i8` (rF2's `signed char` fields, e.g. `mControl`,
/// `mYellowFlagState`, `mSectorFlag[]`) at `off`, or `None` if out of range.
pub fn rd_i8(buf: &[u8], off: usize) -> Option<i8> {
    buf.get(off).map(|&b| b as i8)
}

/// Read a rF2 `bool` (one byte, MSVC `sizeof(bool) == 1`; non-zero = true) at
/// `off`, or `None` if out of range.
pub fn rd_bool(buf: &[u8], off: usize) -> Option<bool> {
    rd_u8(buf, off).map(|b| b != 0)
}

/// Read a `rF2Vec3` (three consecutive `f64`) at `off` as its raw `(x, y, z)`
/// components — unlike [`rd_vec3_magnitude`], this preserves direction, needed
/// for world→local transforms (proximity) and wind direction. `None` if any
/// component is missing.
pub fn rd_vec3(buf: &[u8], off: usize) -> Option<(f64, f64, f64)> {
    let x = rd_f64(buf, off)?;
    let y = rd_f64(buf, off + 8)?;
    let z = rd_f64(buf, off + 16)?;
    Some((x, y, z))
}

/// Read a fixed-width NUL-terminated C string of at most `len` bytes at `off`,
/// lossily decoded as UTF-8 and trimmed. `None` when out of range or empty.
pub fn rd_cstr(buf: &[u8], off: usize, len: usize) -> Option<String> {
    let end = off.checked_add(len)?;
    let raw = buf.get(off..end)?;
    let nul = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    let s = String::from_utf8_lossy(&raw[..nul]).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Magnitude of a `rF2Vec3` (three consecutive `f64`) at `off` — used to turn
/// the car-frame velocity vector into a scalar ground speed (m/s). `None` if any
/// component is missing.
pub fn rd_vec3_magnitude(buf: &[u8], off: usize) -> Option<f32> {
    let x = rd_f64(buf, off)?;
    let y = rd_f64(buf, off + 8)?;
    let z = rd_f64(buf, off + 16)?;
    Some((x * x + y * y + z * z).sqrt() as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a buffer big enough to exercise the readers, writing known values at
    // known offsets, then assert they read back. This validates the decode logic
    // is self-consistent independent of whether the absolute rF2 offsets are
    // calibrated (that needs a live session).
    fn scratch(len: usize) -> Vec<u8> {
        vec![0u8; len]
    }

    #[test]
    fn reads_are_bounds_checked() {
        let buf = scratch(4);
        assert_eq!(rd_f64(&buf, 0), None, "f64 needs 8 bytes");
        assert_eq!(rd_i32(&buf, 1), None, "i32 at 1 runs past 4-byte buf");
        assert_eq!(rd_u32(&buf, usize::MAX), None, "overflow-safe");
        assert_eq!(rd_cstr(&buf, 2, 64), None, "cstr past end");
    }

    #[test]
    fn roundtrips_scalars() {
        let mut buf = scratch(32);
        buf[0..8].copy_from_slice(&(1234.5f64).to_le_bytes());
        buf[8..12].copy_from_slice(&(-3i32).to_le_bytes());
        buf[12..16].copy_from_slice(&(7u32).to_le_bytes());
        assert_eq!(rd_f64(&buf, 0), Some(1234.5));
        assert_eq!(rd_i32(&buf, 8), Some(-3));
        assert_eq!(rd_u32(&buf, 12), Some(7));
    }

    #[test]
    fn cstr_stops_at_nul_and_trims() {
        let mut buf = scratch(64);
        buf[..7].copy_from_slice(b"Monza \0");
        assert_eq!(rd_cstr(&buf, 0, 64).as_deref(), Some("Monza"));
        // All-NUL field reads as absent, not an empty string.
        let empty = scratch(64);
        assert_eq!(rd_cstr(&empty, 0, 64), None);
    }

    #[test]
    fn vec3_magnitude_is_euclidean() {
        let mut buf = scratch(24);
        buf[0..8].copy_from_slice(&(3.0f64).to_le_bytes());
        buf[8..16].copy_from_slice(&(4.0f64).to_le_bytes());
        buf[16..24].copy_from_slice(&(0.0f64).to_le_bytes());
        let m = rd_vec3_magnitude(&buf, 0).unwrap();
        assert!((m - 5.0).abs() < 1e-5, "3-4-5 → 5, got {m}");
    }

    #[test]
    fn vec3_preserves_components() {
        let mut buf = scratch(24);
        buf[0..8].copy_from_slice(&(1.5f64).to_le_bytes());
        buf[8..16].copy_from_slice(&(-2.5f64).to_le_bytes());
        buf[16..24].copy_from_slice(&(9.0f64).to_le_bytes());
        assert_eq!(rd_vec3(&buf, 0), Some((1.5, -2.5, 9.0)));
        assert_eq!(rd_vec3(&buf, 20), None, "16 bytes short of a full Vec3");
    }

    #[test]
    fn small_int_and_bool_readers() {
        let mut buf = scratch(16);
        buf[0..4].copy_from_slice(&(1234.5f32).to_le_bytes());
        buf[4..6].copy_from_slice(&(-7i16).to_le_bytes());
        buf[6] = 0xFE; // -2 as i8 / 254 as u8
        buf[7] = 1; // bool true
        assert_eq!(rd_f32(&buf, 0), Some(1234.5));
        assert_eq!(rd_i16(&buf, 4), Some(-7));
        assert_eq!(rd_u8(&buf, 6), Some(0xFE));
        assert_eq!(rd_i8(&buf, 6), Some(-2));
        assert_eq!(rd_bool(&buf, 7), Some(true));
        assert_eq!(rd_bool(&buf, 8), Some(false));
        assert_eq!(rd_f32(&buf, 13), None, "3 bytes short of an f32");
    }
}
