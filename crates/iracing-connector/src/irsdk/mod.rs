//! Low-level iRacing SDK (irsdk) shared-memory primitives.
//!
//! Layout reference (from the iRacing SDK `irsdk_defines.h`):
//!
//! ```text
//! irsdk_header (112 bytes):
//!   0   i32 ver
//!   4   i32 status            (bit 0 = connected)
//!   8   i32 tickRate          (ticks/sec, e.g. 60)
//!   12  i32 sessionInfoUpdate (bumped when the YAML session string changes)
//!   16  i32 sessionInfoLen
//!   20  i32 sessionInfoOffset
//!   24  i32 numVars
//!   28  i32 varHeaderOffset
//!   32  i32 numBuf            (<= 4)
//!   36  i32 bufLen            (bytes per telemetry buffer row)
//!   40  i32 pad[2]
//!   48  irsdk_varBuf varBuf[4]   (16 bytes each: i32 tickCount, i32 bufOffset, i32 pad[2])
//!
//! irsdk_varHeader (144 bytes):
//!   0   i32 type      (irsdk_VarType)
//!   4   i32 offset    (byte offset within a buffer row)
//!   8   i32 count     (array length; 1 for scalars)
//!   12  bool countAsTime + pad[3]
//!   16  char name[32]
//!   48  char desc[64]
//!   112 char unit[32]
//! ```
//!
//! The sim rotates through up to `numBuf` telemetry buffers; the freshest is the
//! one with the highest `tickCount`.

pub mod header;
pub mod mmap;
pub mod var;

/// Named shared-memory file the sim publishes telemetry into.
pub const MEM_MAP_NAME: &str = "Local\\IRSDKMemMapFileName";

/// Auto-reset event the sim signals when a new telemetry frame is ready.
/// We wait on this instead of busy-polling (perf non-negotiable #3).
pub const DATA_VALID_EVENT_NAME: &str = "Local\\IRSDKDataValidEvent";

/// Max telemetry buffers (`IRSDK_MAX_BUFS`).
pub const MAX_BUFS: usize = 4;

/// Size of `irsdk_header` in bytes.
pub const HEADER_LEN: usize = 48 + MAX_BUFS * VAR_BUF_LEN;

/// Size of one `irsdk_varBuf` entry.
pub const VAR_BUF_LEN: usize = 16;

/// Size of one `irsdk_varHeader`.
pub const VAR_HEADER_LEN: usize = 144;

/// `irsdk_StatusField`: bit set when the sim is connected/live.
pub const STATUS_CONNECTED: i32 = 1;

// Field name lengths inside a varHeader.
pub const MAX_STRING: usize = 32;
