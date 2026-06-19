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
    fn elem_offset(&self, index: usize) -> usize {
        self.offset + index * self.ty.size()
    }

    /// Read element `index` as `f64`, coercing from the native type.
    pub fn read_f64(&self, buf: &[u8], index: usize) -> Option<f64> {
        let off = self.elem_offset(index);
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
        let off = self.elem_offset(index);
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
    Some(i32::from_le_bytes(buf.get(off..off + 4)?.try_into().ok()?))
}

fn read_f32(buf: &[u8], off: usize) -> Option<f32> {
    Some(f32::from_le_bytes(buf.get(off..off + 4)?.try_into().ok()?))
}

fn read_f64_le(buf: &[u8], off: usize) -> Option<f64> {
    Some(f64::from_le_bytes(buf.get(off..off + 8)?.try_into().ok()?))
}
