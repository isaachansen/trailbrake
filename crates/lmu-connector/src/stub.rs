//! Non-Windows fallback. LMU (and the rF2 shared-memory plugin) are Windows-only,
//! so off-Windows the connector compiles to an always-`NotRunning` stub — the
//! type still exists so cross-platform code (source selection, the UI dev build
//! on macOS) can name it without `cfg` noise.

use overlay_core::{Capabilities, ConnectError, SimConnector, SimId, TelemetrySnapshot};

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
        Err(ConnectError::Unsupported)
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        None
    }
}
