//! iRacing variable types and value decoding.
//!
//! All reads are little-endian byte reads out of a copied buffer slice — we
//! never `transmute` the mapped memory, which keeps this sound regardless of
//! alignment.

/// `irsdk_VarType`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VarType {
    Char,
    Bool,
    Int,
    BitField,
    Float,
    Double,
}

impl VarType {
    pub fn from_i32(v: i32) -> Option<Self> {
        Some(match v {
            0 => VarType::Char,
            1 => VarType::Bool,
            2 => VarType::Int,
            3 => VarType::BitField,
            4 => VarType::Float,
            5 => VarType::Double,
            _ => return None,
        })
    }

    /// Size in bytes of a single element of this type.
    pub fn size(self) -> usize {
        match self {
            VarType::Char | VarType::Bool => 1,
            VarType::Int | VarType::BitField | VarType::Float => 4,
            VarType::Double => 8,
        }
    }
}

/// A located variable inside a telemetry buffer row.
#[derive(Clone, Copy, Debug)]
pub struct VarDef {
    pub ty: VarType,
    /// Byte offset of element 0 within a buffer row.
    pub offset: usize,
    /// Number of elements (1 for scalars; 64 for `CarIdx*` arrays).
    // Read in Phase 3 when the `CarIdx*` arrays populate `cars[]`.
    #[allow(dead_code)]
    pub count: usize,
}

impl VarDef {
    fn elem_offset(&self, index: usize) -> Option<usize> {
        if index >= self.count {
            return None;
        }
        index
            .checked_mul(self.ty.size())
            .and_then(|relative| self.offset.checked_add(relative))
    }

    /// Read element `index` as `f64`, coercing from the native type.
    pub fn read_f64(&self, buf: &[u8], index: usize) -> Option<f64> {
        let off = self.elem_offset(index)?;
        Some(match self.ty {
            VarType::Char => *buf.get(off)? as f64,
            VarType::Bool => {
                if *buf.get(off)? != 0 {
                    1.0
                } else {
                    0.0
                }
            }
            VarType::Int | VarType::BitField => read_i32(buf, off)? as f64,
            VarType::Float => read_f32(buf, off)? as f64,
            VarType::Double => read_f64_le(buf, off)?,
        })
    }

    pub fn read_f32(&self, buf: &[u8], index: usize) -> Option<f32> {
        self.read_f64(buf, index).map(|v| v as f32)
    }

    pub fn read_i32(&self, buf: &[u8], index: usize) -> Option<i32> {
        let off = self.elem_offset(index)?;
        Some(match self.ty {
            VarType::Char => *buf.get(off)? as i32,
            VarType::Bool => (*buf.get(off)? != 0) as i32,
            VarType::Int | VarType::BitField => read_i32(buf, off)?,
            VarType::Float => read_f32(buf, off)? as i32,
            VarType::Double => read_f64_le(buf, off)? as i32,
        })
    }

    pub fn read_u32(&self, buf: &[u8], index: usize) -> Option<u32> {
        self.read_i32(buf, index).map(|v| v as u32)
    }

    // Used in Phase 3 for boolean `CarIdx*` vars (e.g. `CarIdxOnPitRoad`).
    #[allow(dead_code)]
    pub fn read_bool(&self, buf: &[u8], index: usize) -> Option<bool> {
        self.read_f64(buf, index).map(|v| v != 0.0)
    }
}

fn read_i32(buf: &[u8], off: usize) -> Option<i32> {
    let end = off.checked_add(4)?;
    Some(i32::from_le_bytes(buf.get(off..end)?.try_into().ok()?))
}

fn read_f32(buf: &[u8], off: usize) -> Option<f32> {
    let end = off.checked_add(4)?;
    Some(f32::from_le_bytes(buf.get(off..end)?.try_into().ok()?))
}

fn read_f64_le(buf: &[u8], off: usize) -> Option<f64> {
    let end = off.checked_add(8)?;
    Some(f64::from_le_bytes(buf.get(off..end)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_reads_reject_indices_at_or_past_count() {
        let def = VarDef {
            ty: VarType::Int,
            offset: 0,
            count: 2,
        };
        let mut buf = Vec::new();
        buf.extend_from_slice(&10i32.to_le_bytes());
        buf.extend_from_slice(&20i32.to_le_bytes());
        buf.extend_from_slice(&30i32.to_le_bytes());

        assert_eq!(def.read_i32(&buf, 0), Some(10));
        assert_eq!(def.read_i32(&buf, 1), Some(20));
        assert_eq!(def.read_i32(&buf, 2), None);
    }

    #[test]
    fn element_offset_rejects_arithmetic_overflow() {
        let def = VarDef {
            ty: VarType::Double,
            offset: usize::MAX - 3,
            count: 2,
        };
        assert_eq!(def.elem_offset(1), None);
        assert_eq!(def.read_f64(&[], 0), None);
    }
}
