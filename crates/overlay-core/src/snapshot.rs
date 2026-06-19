//! The normalized telemetry model.
//!
//! # Units (SI unless noted)
//!
//! All fields use a single, documented unit so widgets never guess and
//! connectors do the conversion once:
//!
//! - speed:        meters per second (`m/s`)
//! - rpm:          revolutions per minute (`rev/min`) — conventional, not SI
//! - angles:       radians (`rad`), positive = counter-clockwise (left)
//! - pedals:       normalized `0.0..=1.0` (0 = released, 1 = fully applied)
//! - fuel:         liters (`L`)
//! - lap distance: fraction of a lap `0.0..=1.0` (`lap_dist_pct`)
//! - lap / sector times & deltas: seconds (`s`)
//! - temperatures: degrees Celsius (`°C`)
//!
//! Every field a given sim might not provide is an [`Option`], so missing data is
//! *handled*, never faked. See [`Capabilities`](crate::Capabilities) for the
//! coarse "does this sim provide X at all" signal widgets use to hide fields.

use serde::{Deserialize, Serialize};

/// Which sim produced this snapshot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SimId {
    #[default]
    Unknown,
    /// Synthetic data from [`MockConnector`](crate::MockConnector).
    Mock,
    IRacing,
    /// Le Mans Ultimate — stubbed seam, not yet implemented.
    Lmu,
}

/// "What changed since the last snapshot", so the frontend store can route
/// updates onto the fast (physics) vs slow (session/scoring) paths and only
/// re-render widgets whose path actually moved (perf non-negotiable #2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeFlags {
    /// Fast path moved: speed/rpm/gear/pedals/steering, ~60 Hz.
    pub fast: bool,
    /// Slow path moved: standings/gaps/lap times/flags/session, a few Hz.
    pub slow: bool,
}

/// Per-snapshot bookkeeping the pipeline and perf HUD rely on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub sim: SimId,
    /// Monotonic counter assigned by the reader (one per emitted snapshot).
    pub tick: u64,
    /// Seconds since the reader started (monotonic; from `Instant`).
    pub frame_timestamp_s: f64,
    /// Sim-native frame counter when available (e.g. iRacing buffer `tickCount`).
    /// Useful for detecting dropped/duplicate frames.
    pub sim_tick: Option<i64>,
    pub changed: ChangeFlags,
}

/// Session / weekend level state. Slow path.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionState {
    pub track_name: Option<String>,
    /// e.g. "Practice", "Qualify", "Race".
    pub session_type: Option<String>,
    pub time_remaining_s: Option<f64>,
    pub laps_remaining: Option<i32>,
    pub total_cars: Option<u32>,
    /// Raw session flag bitfield (sim-specific bits; widgets decode as needed).
    /// For iRacing these are `irsdk_Flags`.
    pub flags_raw: Option<u32>,
    pub air_temp_c: Option<f32>,
    pub track_temp_c: Option<f32>,
    /// Wind speed in m/s.
    #[serde(default)]
    pub wind_speed_ms: Option<f32>,
    /// Wind direction in radians (bearing the wind blows *toward*).
    #[serde(default)]
    pub wind_dir_rad: Option<f32>,
    /// Track wetness fraction `0.0..=1.0` (0 = dry, 1 = soaked).
    #[serde(default)]
    pub track_wetness_pct: Option<f32>,
    /// Precipitation intensity `0.0..=1.0`.
    #[serde(default)]
    pub precipitation_pct: Option<f32>,
    /// Relative humidity `0.0..=1.0`.
    #[serde(default)]
    pub humidity_pct: Option<f32>,
    /// The `car_idx` currently being spectated / observed by the player. `None`
    /// when the player is in their own car or the sim doesn't expose it. Drives
    /// the Highlighted Driver widget.
    #[serde(default)]
    pub spectated_car_idx: Option<u32>,
    /// Race-control message feed (flags, penalties, info). Empty when the sim
    /// provides no parsed message source. Capability `race_control`.
    #[serde(default)]
    pub messages: Vec<RaceControlMessage>,
    /// Broadcast chat feed (for streamers). Empty when no chat source is
    /// connected. Capability `chat`.
    #[serde(default)]
    pub chat_messages: Vec<ChatMessage>,
    /// Normalized track centerline (`[x, y]` in `0.0..=1.0`, y down), a closed
    /// loop, for the track-map widget. `None` when the sim provides no geometry.
    #[serde(default)]
    pub track_path: Option<Vec<[f32; 2]>>,
    /// Corner labels for the track map, positioned in the same normalized
    /// `0.0..=1.0` space as `track_path`. `None` when no turn data is available.
    #[serde(default)]
    pub track_turns: Option<Vec<TrackTurn>>,
}

/// A race-control message (flag change, penalty, info, warning).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RaceControlMessage {
    /// Session time of the message, if known.
    #[serde(default)]
    pub time_s: Option<f64>,
    /// Kind: `"flag"`, `"penalty"`, `"info"`, `"warning"`.
    pub kind: String,
    pub text: String,
    /// Higher = more recent / more important; used for sort + trim.
    #[serde(default)]
    pub priority: u32,
}

/// A chat message from a broadcast chat source (Twitch / YouTube / etc.).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub user: String,
    /// Hex color (`"#rrggbb"`) for the username, if the source provides one.
    #[serde(default)]
    pub color: Option<String>,
    /// Badge label (`"MOD"`, `"VIP"`, etc.), if any.
    #[serde(default)]
    pub badge: Option<String>,
    pub text: String,
    #[serde(default)]
    pub time_s: Option<f64>,
}

/// Per-sector times for one lap (3 sectors). Each is `None` when not yet set.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Sectors {
    #[serde(default)]
    pub s1: Option<f32>,
    #[serde(default)]
    pub s2: Option<f32>,
    #[serde(default)]
    pub s3: Option<f32>,
}

/// Tire pressures for the four corners, in kPa. `None` per corner when unknown.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TirePressures {
    #[serde(default)]
    pub lf_kpa: Option<f32>,
    #[serde(default)]
    pub rf_kpa: Option<f32>,
    #[serde(default)]
    pub lr_kpa: Option<f32>,
    #[serde(default)]
    pub rr_kpa: Option<f32>,
}

/// A labeled corner marker for the track map (e.g. "1", "6A"), placed at a
/// normalized `[x, y]` (`0.0..=1.0`, y down) alongside `SessionState::track_path`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackTurn {
    pub label: String,
    pub x: f32,
    pub y: f32,
}

/// The player's own car. Mix of fast path (pedals/rpm/...) and slow path
/// (position/lap times). The frontend splits these onto the right channels.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlayerState {
    // --- fast path ---
    pub speed_ms: Option<f32>,
    pub rpm: Option<f32>,
    /// Gear: `-1` = reverse, `0` = neutral, `1..` = forward gears.
    pub gear: Option<i32>,
    pub throttle: Option<f32>,
    pub brake: Option<f32>,
    pub clutch: Option<f32>,
    /// Steering wheel angle in radians; positive = left.
    pub steering_rad: Option<f32>,
    /// Fraction around the lap, `0.0..=1.0`.
    pub lap_dist_pct: Option<f32>,

    // --- slow-ish path ---
    pub fuel_l: Option<f32>,
    pub fuel_per_lap_l: Option<f32>,
    pub lap: Option<i32>,
    pub current_lap_s: Option<f32>,
    pub last_lap_s: Option<f32>,
    pub best_lap_s: Option<f32>,
    /// Live delta to the player's best lap (seconds; negative = faster).
    pub delta_best_s: Option<f32>,
    /// Live delta to the session best lap (seconds; negative = faster).
    pub delta_session_best_s: Option<f32>,
    pub position: Option<u32>,
    pub class_position: Option<u32>,
    /// The player's own `car_idx`, so widgets can find the player in `cars`.
    pub car_idx: Option<u32>,
    /// The player's car model name (e.g. "Ferrari 296 GT3"), for per-car layout
    /// profile auto-switching.
    pub car_name: Option<String>,
    /// Whether the player is currently on track (driving) vs in the garage.
    /// `None` when the sim doesn't distinguish; widgets that gate on garage/track
    /// only do so when this is known.
    pub on_track: Option<bool>,
    /// Whether the player is in the garage. Combined with `on_track` this lets
    /// widgets distinguish in-car / out-of-car / in-garage session states.
    pub in_garage: Option<bool>,
    /// Spotter: a car is alongside on the left / right (iRacing `CarLeftRight`).
    /// Drives the spotter overlay / screen-edge warning.
    pub car_left: Option<bool>,
    pub car_right: Option<bool>,

    // --- pit / setup helpers (slow-ish) ---
    /// Pit-lane speed limit in m/s, if the sim exposes it.
    #[serde(default)]
    pub pit_speed_limit_ms: Option<f32>,
    /// Distance to the player's pit box in meters (negative = past it). Drives
    /// the Pitlane Helper countdown. `None` when not on pit road / unknown.
    #[serde(default)]
    pub pit_box_dist_m: Option<f32>,
    /// Current-lap sector split times. `None` per sector until crossed.
    #[serde(default)]
    pub sector_times_s: Sectors,
    /// Best-lap sector split times.
    #[serde(default)]
    pub sector_best_s: Sectors,

    // --- in-car settings / statuses (for the Dash Cluster / setup tools) ---
    /// Brake bias fraction `0.0..=1.0` (front bias).
    #[serde(default)]
    pub brake_bias_pct: Option<f32>,
    /// ABS active this frame.
    #[serde(default)]
    pub abs_active: Option<bool>,
    /// Traction-control active/intervention this frame.
    #[serde(default)]
    pub tc_active: Option<bool>,
    /// DRS state: 0=unavailable, 1=available, 2=armed, 3=active.
    #[serde(default)]
    pub drs_state: Option<i32>,
    /// ERS deployment fraction `0.0..=1.0`.
    #[serde(default)]
    pub ers_pct: Option<f32>,
    /// Fuel mix level (sim-specific integer).
    #[serde(default)]
    pub fuel_mix: Option<i32>,
    /// Push-to-pass remaining uses (or status, sim-specific).
    #[serde(default)]
    pub p2p_available: Option<i32>,
    /// Tire pressures for the four corners (kPa), for setup comparison.
    #[serde(default)]
    pub tire_pressures: TirePressures,
}

/// One car in the field (including, redundantly, the player — widgets pick).
/// Slow path. Phase 1 leaves this empty for the live iRacing source; the
/// Relative/Standings widgets (Phase 3) are what populate and consume it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CarState {
    /// Stable per-session id (iRacing `CarIdx`, 0..63).
    pub car_idx: u32,
    pub driver_name: Option<String>,
    /// Car model display name (e.g. "Dallara P217"); a class-label fallback when
    /// the sim leaves the short class name blank.
    pub car_screen_name: Option<String>,
    /// Class identifier for multiclass ordering/coloring.
    pub car_class_id: Option<u32>,
    /// Short class name, e.g. "GT3" (for multiclass group headers).
    pub car_class_name: Option<String>,
    /// Class color as 0xRRGGBB, if the sim provides it (multiclass).
    pub class_color: Option<u32>,
    /// Car number (e.g. "92").
    pub car_number: Option<String>,
    /// 2-letter country code for a flag swatch (sim may not provide).
    pub country: Option<String>,
    /// Positions gained (+) / lost (−) since the start.
    pub positions_gained: Option<i32>,
    pub irating_delta: Option<i32>,
    /// Tyre compound letter (S/M/H/W), if the sim exposes it.
    pub tyre: Option<String>,
    pub position: Option<u32>,
    pub class_position: Option<u32>,
    pub lap: Option<i32>,
    pub lap_dist_pct: Option<f32>,
    /// Signed gap to the player in seconds (positive = ahead on track-time).
    pub gap_to_player_s: Option<f32>,
    pub last_lap_s: Option<f32>,
    pub best_lap_s: Option<f32>,
    pub on_pit_road: Option<bool>,
    pub irating: Option<i32>,
    pub safety_rating: Option<String>,
    /// Lateral offset from the player in meters (+right / −left), for the radar.
    /// `None` unless the sim exposes neighbouring-car positions (cap `proximity`).
    #[serde(default)]
    pub rel_lat_m: Option<f32>,
    /// Longitudinal offset from the player in meters (+ahead / −behind).
    #[serde(default)]
    pub rel_lon_m: Option<f32>,
    /// Pit-stop status (sim-specific enum). For iRacing `CarIdxPitStopStatus`:
    /// 0=none, 1=pitting, 2=leaving, 3=stopped. Widgets map to DNF/TOW/OUT/PIT.
    #[serde(default)]
    pub pit_status: Option<u32>,
    /// True when this car holds the session fastest lap.
    #[serde(default)]
    pub has_session_fastest: Option<bool>,
}

/// A single normalized frame. This is the only shape the frontend ever sees.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TelemetrySnapshot {
    pub meta: Meta,
    pub session: SessionState,
    pub player: PlayerState,
    pub cars: Vec<CarState>,
}
