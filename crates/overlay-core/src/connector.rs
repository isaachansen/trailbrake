//! The `SimConnector` trait — the swappable-data-source seam.
//!
//! Keep it minimal and sim-agnostic. Everything below this boundary may be
//! sim-specific; everything above speaks only [`TelemetrySnapshot`].

use crate::snapshot::{SimId, TelemetrySnapshot};

/// Coarse "does this sim provide X at all" flags, so widgets can gracefully
/// hide fields a given sim can't fill (e.g. iRating on a sim without it).
///
/// This is intentionally a small fixed set for Phase 1; it will grow as widgets
/// need finer-grained capability gates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub clutch: bool,
    pub steering_angle: bool,
    pub fuel: bool,
    /// Provides live lap deltas (delta-to-best etc.).
    pub deltas: bool,
    /// Provides enough per-car data to compute relative gaps.
    pub relative_gaps: bool,
    pub irating: bool,
    pub safety_rating: bool,
    pub multiclass: bool,
    /// Provides relative lateral/longitudinal car positions for the radar.
    pub proximity: bool,
    /// Provides track centerline geometry for the track map.
    pub track_map: bool,
    /// Provides a race-control message feed (flags / penalties / info).
    pub race_control: bool,
    /// A broadcast chat source is connected (e.g. stream chat).
    pub chat: bool,
    /// Provides weather data (wind, wetness, precipitation, humidity, temps).
    pub weather: bool,
    /// Provides per-sector split times.
    pub sectors: bool,
    /// Provides in-car setup states (brake bias, ABS, TC, DRS, ERS, tire pressures).
    pub car_setup: bool,
    /// Provides the currently spectated car index (camera target).
    pub spectator: bool,
    /// Provides pit-lane info (speed limit, pit-box distance, per-car pit status).
    pub pit_info: bool,
}

/// Why a connect attempt failed. Deliberately small; the reader treats most of
/// these as "retry later".
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectError {
    /// The sim does not appear to be running (no shared memory / process).
    NotRunning,
    /// Platform can't support this connector (e.g. iRacing on macOS).
    Unsupported,
    /// Something went wrong talking to the OS / sim.
    Os(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::NotRunning => write!(f, "sim is not running"),
            ConnectError::Unsupported => write!(f, "connector unsupported on this platform"),
            ConnectError::Os(msg) => write!(f, "os error: {msg}"),
        }
    }
}

impl std::error::Error for ConnectError {}

/// A source of normalized telemetry. One implementation per sim.
///
/// Implementations own their connection to the sim (perf non-negotiable #4:
/// widgets never touch shared memory). The reader thread drives a single
/// connector and fans the results out.
pub trait SimConnector: Send {
    /// Which sim this connector represents.
    fn sim_id(&self) -> SimId;

    /// Establish (or re-establish) the connection to the sim.
    fn connect(&mut self) -> Result<(), ConnectError>;

    fn is_connected(&self) -> bool;

    /// What this sim can provide, so widgets can hide unsupported fields.
    fn capabilities(&self) -> Capabilities;

    /// Produce the next frame.
    ///
    /// Implementations should *block up to a short internal timeout* waiting for
    /// the sim's "data ready" signal rather than busy-spinning, then return:
    /// - `Some(snapshot)` when a fresh frame is available,
    /// - `None` on timeout / no new frame / not connected (the reader will
    ///   loop again, and re-`connect()` if `is_connected()` has gone false).
    fn poll(&mut self) -> Option<TelemetrySnapshot>;
}

// `SimConnector: Send` ⇒ `dyn SimConnector` is `Send`, so the reader thread can
// own a boxed, runtime-selected source (live / mock / replay).
impl SimConnector for Box<dyn SimConnector> {
    fn sim_id(&self) -> SimId {
        (**self).sim_id()
    }
    fn connect(&mut self) -> Result<(), ConnectError> {
        (**self).connect()
    }
    fn is_connected(&self) -> bool {
        (**self).is_connected()
    }
    fn capabilities(&self) -> Capabilities {
        (**self).capabilities()
    }
    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        (**self).poll()
    }
}
