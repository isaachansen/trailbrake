//! Le Mans Ultimate connector — **STUB / SEAM ONLY**.
//!
//! This crate exists to make the "add a sim" seam visible (§10): adding a sim is
//! implementing [`overlay_core::SimConnector`] + a normalization mapping, and
//! nothing above the connector boundary changes. It is intentionally **not
//! implemented** yet — every method is a no-op/`NotRunning` placeholder.
//!
//! # Implementation notes for when this is built out
//!
//! LMU is built on the rFactor 2 engine and exposes the same shared-memory
//! plugin interface. A real implementation would:
//!
//! - Open two named mappings (Windows, like the iRacing connector):
//!     * `$rFactor2SMMP_Telemetry$`  — physics, ~50 Hz  → the FAST path
//!     * `$rFactor2SMMP_Scoring$`    — session/standings, ~5 Hz → the SLOW path
//!   (optionally `$rFactor2SMMP_Rules$`, `$rFactor2SMMP_PitInfo$`, etc.)
//! - Use **version-based torn-frame detection**: each buffer has
//!   `mVersionUpdateBegin` / `mVersionUpdateEnd` counters; copy the buffer, and
//!   if begin != end (or it changed across the copy) retry — analogous to the
//!   iRacing `tickCount` re-check in `iracing-connector`.
//! - Normalize rF2's structs into [`overlay_core::TelemetrySnapshot`] in SI units
//!   (rF2 speed is m/s already; angles rad; map `mGear`, pedal inputs `0..1`,
//!   `mElapsedTime`/lap times, and the scoring vehicle array → `cars[]`).
//! - Report [`Capabilities`] for what LMU/rF2 actually provides.
//!
//! Crucially, all of that lives *below* this boundary; the widgets and UI never
//! change.

use overlay_core::{Capabilities, ConnectError, SimConnector, SimId, TelemetrySnapshot};

/// Stub connector for Le Mans Ultimate. Always reports "not running".
#[derive(Default)]
pub struct LmuConnector {
    _private: (),
}

impl LmuConnector {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SimConnector for LmuConnector {
    fn sim_id(&self) -> SimId {
        SimId::Lmu
    }

    fn connect(&mut self) -> Result<(), ConnectError> {
        // TODO: open `$rFactor2SMMP_Telemetry$` / `$rFactor2SMMP_Scoring$`.
        Err(ConnectError::NotRunning)
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        // TODO: copy buffers with version-based torn-frame detection, normalize.
        None
    }
}
