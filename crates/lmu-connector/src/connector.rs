//! `LmuConnector`: reads the rF2 shared-memory mappings LMU publishes and
//! normalizes them into [`overlay_core::TelemetrySnapshot`].
//!
//! Beyond the already-verified player fast-path (speed/rpm/gear/pedals/lap),
//! this decodes: the full field (`cars[]`) from the scoring buffer, per-car
//! relative gaps and radar proximity, weather, the sim-neutral flag state (+
//! race-control messages on transitions), sectors, fuel-per-lap, and
//! best-effort pit info from the low-frequency Extended mapping. See
//! `crate::rf2` for the byte-offset reference and calibration status of every
//! field used below — offsets marked 🧪 there are correct-by-construction from
//! the authoritative struct layout but unverified against live bytes; the
//! `OVERLAY_DUMP_RF2` dump (see [`LmuConnector::dump_once`]) is how the user
//! validates them against a running session.

use std::collections::HashMap;
use std::time::Duration;

use overlay_core::{
    Capabilities, CarState, ChangeFlags, ConnectError, FlagState, Meta, PlayerState,
    RaceControlMessage, Sectors, SessionState, SimConnector, SimId, TelemetrySnapshot,
    TirePressures,
};

use crate::rf2::decode::{rd_bool, rd_cstr, rd_f32, rd_f64, rd_i16, rd_i32, rd_i8, rd_u8, rd_vec3, rd_vec3_magnitude};
use crate::rf2::mmap::MappedRegion;
use crate::rf2::{ext, scor, session_label, tele, EXTENDED_MAP, SCORING_MAP, TELEMETRY_MAP};

/// Poll pause between frame copies. rF2 physics runs ~50–90 Hz; polling at
/// ~200 Hz (5 ms) catches every frame without a hot spin, and the version-based
/// dedup below drops repeats so we never re-emit a frame the sim didn't advance.
const POLL_SLEEP: Duration = Duration::from_millis(5);

/// Hard cap on vehicles scanned per frame — matches the plugin's own
/// `MAX_MAPPED_VEHICLES`, and bounds every loop below regardless of what
/// `mNumVehicles` claims (defense against a torn/garbage read).
const MAX_VEHICLES: usize = 128;

/// Decode the sim-neutral [`FlagState`] from rF2's scoring-buffer flag sources.
///
/// Priority (highest first), per the rF2 → neutral mapping: Checkered (session
/// over) > Red (session stopped / race-halt) > Yellow (full-course or local) >
/// Blue (player shown the blue flag) > None.
/// rF2 exposes no White/Debris/Black signal in these buffers, so those states
/// are simply never produced for LMU (honest — not faked).
///
/// Note there is deliberately NO Green branch: a green flag is a momentary
/// real-world event (waved at the start/restart), but rF2 only exposes it as
/// `mGamePhase == 5 (GreenFlag)`, a *persistent phase* that stays set for the
/// entire green-flag stint. Surfacing that as a standing `FlagState::Green`
/// would light the flag widget for the whole race. Instead a validated
/// green-flag phase with no caution falls through to `None` — the widget hides
/// on `None`, which is the honest, iRacing-consistent representation of
/// "racing normally, no flag to show" (iRacing's GREEN bit likewise only sets
/// momentarily at start/restart, not during clean green running).
///
/// Every input is validated against its documented enum range before it's
/// trusted; anything out of range is treated as unknown and ignored rather
/// than folded into a branch below. This matters because `mGamePhase` /
/// `mYellowFlagState` / `mSectorFlag` all live at scoring-info offsets past
/// the assumed 8-byte `pointer1[8]` at 96..104 (see `crate::rf2::scor::info`,
/// marked 🧪 — correct-by-construction but unverified against live bytes). If
/// that pointer-size assumption is even slightly off, these bytes are
/// garbage — and a garbage byte is non-zero far more often than it's zero, so
/// treating "any non-zero" as a signal (the previous behavior, for
/// `mSectorFlag`) produced Yellow almost unconditionally. Range/value
/// validation turns "any non-zero garbage byte" into "the exact byte pattern
/// rF2 actually documents", which is what stops a bad offset from producing a
/// permanent false Yellow.
///
/// `mYellowFlagState` — not `mGamePhase` — is the authoritative full-course
/// caution signal: it's a purpose-built enum (-1 invalid, 0 none, 1..=6
/// various caution phases, 7 race halt) rather than a game-phase value we'd
/// otherwise have to infer caution from. `mGamePhase == 6` is kept as a
/// secondary Yellow signal (still range-validated first).
fn flag_from_rf2(
    game_phase: Option<u8>,
    yellow_flag_state: Option<i8>,
    sector_flags: [Option<i8>; 3],
    player_flag: Option<u8>,
) -> FlagState {
    // mGamePhase only defines 0..=8 (before_session .. session_stopped). A
    // byte outside that range is a torn/garbage read — ignore it entirely
    // rather than matching it against any branch below.
    let game_phase = game_phase.filter(|&p| p <= 8);
    // mYellowFlagState: -1 invalid, 0 none, 1..=6 caution phases, 7 race halt.
    let yellow_flag_state = yellow_flag_state.filter(|&v| (-1..=7).contains(&v));
    let yellow_caution = matches!(yellow_flag_state, Some(1..=6));

    // mSectorFlag[i] documents a small "local yellow present" indicator, and
    // the ONLY value that means that is 1. Counting any non-zero byte (the
    // previous behavior) meant a garbage read from this unverified offset was
    // yellow ~255/256 of the time — this was the actual root cause of the
    // "always yellow" bug. Any other value, including other non-zero bytes,
    // is noise and is ignored rather than trusted.
    let any_sector_yellow = sector_flags.iter().any(|f| *f == Some(1));

    if game_phase == Some(8) {
        FlagState::Checkered
    } else if game_phase == Some(7) || yellow_flag_state == Some(7) {
        FlagState::Red
    } else if yellow_caution || game_phase == Some(6) || any_sector_yellow {
        FlagState::Yellow
    } else if player_flag == Some(6) {
        FlagState::Blue
    } else {
        // No Green branch on purpose: `game_phase == 5` (GreenFlag) is a
        // persistent phase held for the whole green stint, so mapping it to a
        // standing flag would light the widget all race. A validated green
        // phase with no caution falls through here to None — see the fn doc.
        FlagState::None
    }
}

/// rF2 uses `<= 0` as "not set" for lap/sector times (mirrors iRacing's `-1`
/// sentinel, just a different value).
fn lap_time(v: Option<f64>) -> Option<f32> {
    v.filter(|&t| t > 0.0).map(|t| t as f32)
}

/// Turn rF2's cumulative sector splits (`s1`, `s1+s2`) plus the lap total into
/// individual per-sector durations. A sentinel (`<= 0`) or non-increasing
/// cumulative value yields `None` for that sector rather than a bogus/negative
/// duration — e.g. mid-lap, `s2_cum` is `None` (not yet crossed) and `s3`
/// naturally stays `None` too (no lap total exists until the lap finishes).
fn sectors_from_cumulative(s1_cum: Option<f64>, s2_cum: Option<f64>, lap_total: Option<f64>) -> Sectors {
    let s1 = lap_time(s1_cum);
    let s2 = match (s1_cum, s2_cum) {
        (Some(a), Some(b)) if a > 0.0 && b > a => Some((b - a) as f32),
        _ => None,
    };
    let s3 = match (s2_cum, lap_total) {
        (Some(b), Some(t)) if b > 0.0 && t > b => Some((t - b) as f32),
        _ => None,
    };
    Sectors { s1, s2, s3 }
}

/// Fold a raw time-into-lap delta into the shortest signed gap, wrapping across
/// the start/finish line. Same technique as the iRacing connector's
/// `CarIdxEstTime` handling (see `crates/iracing-connector/src/connector.rs`),
/// applied here to rF2's `mTimeIntoLap` (the rF2 analogue of `CarIdxEstTime` —
/// both are "time from the start/finish line to this car's current position").
fn wrap_gap(delta: f32, lap_len_s: Option<f32>) -> f32 {
    match lap_len_s {
        Some(l) if l > 1.0 && delta.is_finite() => {
            let m = delta.rem_euclid(l);
            if m > l / 2.0 {
                m - l
            } else {
                m
            }
        }
        _ => delta,
    }
}

/// Rank each entry within its class by `positions[i]` (ascending), producing a
/// per-entry `class_position`. Entries with no class name are left `None`
/// (can't be grouped); entries with no overall position are ranked last within
/// their class but still get `None` (nothing to report).
fn class_positions(classes: &[Option<String>], positions: &[Option<u32>]) -> Vec<Option<u32>> {
    let n = classes.len();
    let mut result = vec![None; n];
    let mut by_class: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, c) in classes.iter().enumerate() {
        if let Some(name) = c.as_deref() {
            by_class.entry(name).or_default().push(i);
        }
    }
    for idxs in by_class.values_mut() {
        idxs.sort_by_key(|&i| positions[i].unwrap_or(u32::MAX));
        for (rank, &i) in idxs.iter().enumerate() {
            if positions[i].is_some() {
                result[i] = Some(rank as u32 + 1);
            }
        }
    }
    result
}

/// Small curated palette so multiclass grouping gets a stable, readable color
/// per class without needing the sim to provide one (rF2 doesn't). Picked by a
/// cheap stable hash of the class name, so the same class always maps to the
/// same color within a session (and across sessions).
const CLASS_PALETTE: [u32; 8] = [
    0xE0483B, // red
    0x3B8EE0, // blue
    0x3BE07A, // green
    0xE0C43B, // yellow
    0xB33BE0, // purple
    0xE07A3B, // orange
    0x3BE0D4, // teal
    0xE03B9E, // pink
];

fn class_color_from_name(name: &str) -> u32 {
    // FNV-1a-ish: cheap, stable, no external dependency.
    let mut hash: u32 = 2166136261;
    for b in name.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    CLASS_PALETTE[(hash as usize) % CLASS_PALETTE.len()]
}

/// Scan up to `count` fixed-stride records for one whose `id_off` field equals
/// `id`. Bounds-checked via `rd_i32`; a torn/short buffer just fails to match.
fn find_index_by_id(buf: &[u8], base: usize, stride: usize, id_off: usize, count: usize, id: i32) -> Option<usize> {
    (0..count).find(|&i| rd_i32(buf, base + i * stride + id_off) == Some(id))
}

/// Scan the scoring buffer for the vehicle with `mIsPlayer == true`.
fn find_scoring_player(buf: &[u8], count: usize) -> Option<usize> {
    (0..count).find(|&i| rd_bool(buf, scor::veh_offset(i) + scor::veh::IS_PLAYER).unwrap_or(false))
}

/// Transform a world-space delta into the player's local frame using the
/// player's orientation matrix (`mOri`, rows = world components of local axes;
/// since it's a rotation matrix, the transpose maps world → local — see the
/// doc on `scor::veh::ORI`). Returns `(local_x, local_z)`.
///
/// Axis convention (✅ lateral confirmed by live radar): rF2 local axes are
/// X = +left, Z = +rear. Our normalized model uses rel_lat = +right and
/// rel_lon = +ahead, so the call site negates BOTH components. Returns the raw
/// rF2 `(local_x, local_z)`; the sign flip lives at the call site.
fn world_to_local_xz(player_pos: (f64, f64, f64), player_ori: [(f64, f64, f64); 3], world_pos: (f64, f64, f64)) -> (f32, f32) {
    let d = (world_pos.0 - player_pos.0, world_pos.1 - player_pos.1, world_pos.2 - player_pos.2);
    let local_x = player_ori[0].0 * d.0 + player_ori[1].0 * d.1 + player_ori[2].0 * d.2;
    let local_z = player_ori[0].2 * d.0 + player_ori[1].2 * d.1 + player_ori[2].2 * d.2;
    (local_x as f32, local_z as f32)
}

/// Read the 3-row orientation matrix at `base` (a `mOri` field), or `None` if
/// any row is out of bounds.
fn read_ori(buf: &[u8], base: usize) -> Option<[(f64, f64, f64); 3]> {
    let r0 = rd_vec3(buf, base)?;
    let r1 = rd_vec3(buf, base + 24)?;
    let r2 = rd_vec3(buf, base + 48)?;
    Some([r0, r1, r2])
}

pub struct LmuConnector {
    telemetry: Option<MappedRegion>,
    scoring: Option<MappedRegion>,
    /// Best-effort low-frequency mapping (physics options, pit speed limit).
    /// `None` when absent — `pit_info` capability follows this.
    extended: Option<MappedRegion>,
    /// Reused copy buffers, so a steady-state poll allocates nothing.
    tele_buf: Vec<u8>,
    scor_buf: Vec<u8>,
    ext_buf: Vec<u8>,
    /// Last telemetry version we emitted, to skip unchanged frames.
    last_tele_version: Option<u32>,
    /// Fuel-history ring for deriving `fuel_per_lap_l`: `(lap_number, fuel_at_lap_crossing_l)`.
    fuel_history: Vec<(i32, f32)>,
    /// Previous player lap number, for detecting lap crossings.
    prev_lap: Option<i32>,
    /// Previous player fuel level, for capturing per-lap burn at lap crossing.
    prev_fuel: Option<f32>,
    /// Previous decoded flag state, for generating race-control messages on
    /// transitions.
    prev_flag: FlagState,
    /// Accumulated race-control messages (bounded).
    messages: Vec<RaceControlMessage>,
    /// Previous track name, to detect a track/session change and reset the
    /// per-session derived state above (fuel history, messages, flag) so
    /// nothing leaks across sessions.
    prev_track_name: Option<String>,
    /// Whether the one-shot `OVERLAY_DUMP_RF2` calibration dump has run.
    dumped: bool,
}

impl Default for LmuConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl LmuConnector {
    pub fn new() -> Self {
        Self {
            telemetry: None,
            scoring: None,
            extended: None,
            tele_buf: Vec::new(),
            scor_buf: Vec::new(),
            ext_buf: Vec::new(),
            last_tele_version: None,
            fuel_history: Vec::new(),
            prev_lap: None,
            prev_fuel: None,
            prev_flag: FlagState::None,
            messages: Vec::new(),
            prev_track_name: None,
            dumped: false,
        }
    }

    /// Average recent per-lap fuel burn from the history ring (last 5 laps),
    /// mirroring the iRacing connector's `fuel_per_lap`.
    fn fuel_per_lap(&self) -> Option<f32> {
        if self.fuel_history.len() < 2 {
            return None;
        }
        let burns: Vec<f32> = self
            .fuel_history
            .windows(2)
            .filter_map(|w| {
                let (_, f0) = w[0];
                let (_, f1) = w[1];
                if f0 > f1 {
                    Some(f0 - f1)
                } else {
                    None
                }
            })
            .collect();
        if burns.is_empty() {
            return None;
        }
        let n = burns.len().min(5);
        let recent = &burns[burns.len() - n..];
        Some(recent.iter().sum::<f32>() / n as f32)
    }

    /// Append a race-control message when the decoded flag state changes.
    fn on_flag_changed(messages: &mut Vec<RaceControlMessage>, prev: &mut FlagState, new_flag: FlagState) {
        if new_flag == *prev {
            return;
        }
        let (kind, text, prio): (&str, &str, u32) = match new_flag {
            FlagState::Green => ("flag", "Green flag — session running", 10),
            FlagState::Yellow => ("flag", "Yellow flag — caution", 20),
            FlagState::Red => ("flag", "Red flag — session stopped", 30),
            FlagState::Checkered => ("flag", "Checkered flag — session over", 40),
            FlagState::Blue => ("flag", "Blue flag — leaders approaching", 12),
            FlagState::White => ("flag", "White flag — last lap", 15),
            FlagState::Black => ("penalty", "Black flag — penalty", 25),
            FlagState::Debris => ("info", "Debris on track", 18),
            FlagState::None => ("flag", "Flag cleared", 5),
        };
        if !messages.last().is_some_and(|m| m.text == text) {
            messages.push(RaceControlMessage {
                time_s: None, // rF2 gives no session clock we thread through here
                kind: kind.to_string(),
                text: text.to_string(),
                priority: prio,
            });
            if messages.len() > 50 {
                let drop = messages.len() - 50;
                messages.drain(0..drop);
            }
        }
        *prev = new_flag;
    }

    /// One-shot diagnostic (gated on `OVERLAY_DUMP_RF2`): print region sizes,
    /// version counters, vehicle count, a hex/field scan over the first
    /// telemetry vehicle (as before), PLUS the scoring buffer's `mNumVehicles`,
    /// the `mIsPlayer` scan result, and computed values for every new field —
    /// the calibration aid for this stage. Confirm each printed value looks
    /// physically sane (fuel in liters, pressures ~100-300 kPa, temps in a
    /// plausible °C range, etc.); a wildly wrong number pinpoints a bad offset
    /// in `rf2::mod` to fix.
    fn dump_once(&mut self, tele_version: u32, scor_version: Option<u32>) {
        if self.dumped || std::env::var_os("OVERLAY_DUMP_RF2").is_none() {
            return;
        }
        self.dumped = true;
        let tele_len = self.telemetry.as_ref().map(MappedRegion::len).unwrap_or(0);
        let scor_len = self.scoring.as_ref().map(MappedRegion::len).unwrap_or(0);
        let ext_len = self.extended.as_ref().map(MappedRegion::len).unwrap_or(0);
        let num_vehicles = rd_i32(&self.tele_buf, tele::NUM_VEHICLES);
        eprintln!(
            "[OVERLAY_DUMP_RF2] telemetry: {tele_len} bytes, version {tele_version}, mNumVehicles={num_vehicles:?}"
        );
        eprintln!("[OVERLAY_DUMP_RF2] scoring: {scor_len} bytes, version {scor_version:?}");
        eprintln!("[OVERLAY_DUMP_RF2] extended: {ext_len} bytes ({})", if self.extended.is_some() { "mapped" } else { "absent" });

        let base = tele::VEHICLES;
        eprintln!("[OVERLAY_DUMP_RF2] vehicle[0] field scan (veh offset | f64@off | f64@off+4 | i32):");
        for off in (0..480).step_by(8) {
            let f = rd_f64(&self.tele_buf, base + off);
            let f4 = rd_f64(&self.tele_buf, base + off + 4);
            let i = rd_i32(&self.tele_buf, base + off);
            if let (Some(f), Some(f4), Some(i)) = (f, f4, i) {
                eprintln!("  +{off:<3}  {f:>13.3}  {f4:>13.3}  i32={i}");
            }
        }

        eprintln!(
            "[OVERLAY_DUMP_RF2] vehicle[0] new fields: fuel_l={:?} rear_brake_bias={:?} physical_wheel_range_deg={:?} battery_charge_frac={:?}",
            rd_f64(&self.tele_buf, base + tele::veh::FUEL),
            rd_f64(&self.tele_buf, base + tele::veh::REAR_BRAKE_BIAS),
            rd_f32(&self.tele_buf, base + tele::veh::PHYSICAL_STEERING_WHEEL_RANGE),
            rd_f64(&self.tele_buf, base + tele::veh::BATTERY_CHARGE_FRACTION),
        );
        for w in 0..4 {
            eprintln!(
                "  wheel[{w}] pressure_kpa={:?}",
                rd_f64(&self.tele_buf, tele::veh::wheel::offset(base, w, tele::veh::wheel::PRESSURE))
            );
        }

        if !self.scor_buf.is_empty() {
            let info = scor::SCORING_INFO;
            let scor_num_vehicles = rd_i32(&self.scor_buf, info + scor::info::NUM_VEHICLES);
            let player_idx = find_scoring_player(&self.scor_buf, num_vehicles.unwrap_or(0).max(0) as usize);
            eprintln!(
                "[OVERLAY_DUMP_RF2] scoring info: mNumVehicles={scor_num_vehicles:?} mGamePhase={:?} mYellowFlagState={:?} track_len_m={:?} ambient_c={:?} track_c={:?} raining={:?} max_wetness={:?}",
                rd_u8(&self.scor_buf, info + scor::info::GAME_PHASE),
                rd_i8(&self.scor_buf, info + scor::info::YELLOW_FLAG_STATE),
                rd_f64(&self.scor_buf, info + scor::info::LAP_DIST),
                rd_f64(&self.scor_buf, info + scor::info::AMBIENT_TEMP),
                rd_f64(&self.scor_buf, info + scor::info::TRACK_TEMP),
                rd_f64(&self.scor_buf, info + scor::info::RAINING),
                rd_f64(&self.scor_buf, info + scor::info::MAX_PATH_WETNESS),
            );
            eprintln!("[OVERLAY_DUMP_RF2] scoring mIsPlayer scan found index: {player_idx:?}");
            if let Some(pi) = player_idx {
                let pbase = scor::veh_offset(pi);
                eprintln!(
                    "[OVERLAY_DUMP_RF2] player scoring row: id={:?} place={:?} lap_dist={:?} best_lap={:?} last_lap={:?} class={:?} driver={:?}",
                    rd_i32(&self.scor_buf, pbase + scor::veh::ID),
                    rd_u8(&self.scor_buf, pbase + scor::veh::PLACE),
                    rd_f64(&self.scor_buf, pbase + scor::veh::LAP_DIST),
                    rd_f64(&self.scor_buf, pbase + scor::veh::BEST_LAP_TIME),
                    rd_f64(&self.scor_buf, pbase + scor::veh::LAST_LAP_TIME),
                    rd_cstr(&self.scor_buf, pbase + scor::veh::VEHICLE_CLASS, scor::veh::VEHICLE_CLASS_LEN),
                    rd_cstr(&self.scor_buf, pbase + scor::veh::DRIVER_NAME, scor::veh::DRIVER_NAME_LEN),
                );
            }
        }

        if !self.ext_buf.is_empty() {
            eprintln!(
                "[OVERLAY_DUMP_RF2] extended mCurrentPitSpeedLimit_ms={:?}",
                rd_f32(&self.ext_buf, ext::CURRENT_PIT_SPEED_LIMIT)
            );
        }
    }

    /// Read the Extended mapping's pit speed limit, rejecting an implausible
    /// value (outside `0.0..100.0` m/s ≈ 360 km/h) rather than trusting a
    /// possibly-miscalibrated deep offset — see `rf2::ext` doc.
    fn pit_speed_limit(&self) -> Option<f32> {
        let v = rd_f32(&self.ext_buf, ext::CURRENT_PIT_SPEED_LIMIT)?;
        if v.is_finite() && v > 0.0 && v < 100.0 {
            Some(v)
        } else {
            None
        }
    }
}

impl SimConnector for LmuConnector {
    fn sim_id(&self) -> SimId {
        SimId::Lmu
    }

    fn connect(&mut self) -> Result<(), ConnectError> {
        // Telemetry is the liveness signal: if it's absent, LMU isn't running
        // (or the plugin isn't installed). Scoring and Extended are
        // best-effort — a session may briefly expose one before the other, and
        // Extended in particular is optional (pit_info capability follows it).
        let telemetry = MappedRegion::open(TELEMETRY_MAP)?;
        self.scoring = MappedRegion::open(SCORING_MAP).ok();
        self.extended = MappedRegion::open(EXTENDED_MAP).ok();
        self.telemetry = Some(telemetry);
        self.last_tele_version = None;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.telemetry.is_some()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            clutch: true,
            steering_angle: true, // mFilteredSteering * (mPhysicalSteeringWheelRange/2), to radians
            fuel: true,           // mFuel (+ fuel_per_lap from lap-crossing history)
            deltas: false,        // no live distance-indexed delta computed (prefer honest false)
            relative_gaps: true,  // mTimeIntoLap folded gap (approximate; see wrap_gap doc)
            irating: false,       // no such concept in rF2
            safety_rating: false, // no such concept in rF2
            multiclass: true,     // mVehicleClass + computed class_position
            proximity: true,      // mPos/mOri world→local transform (axis assumption, see doc)
            track_map: false,     // no baked LMU centerline source (deferred)
            race_control: true,   // FlagState transitions -> messages
            chat: false,          // no broadcast chat source wired
            weather: true,        // mAmbientTemp/mTrackTemp/mWind/mRaining/mMaxPathWetness
            sectors: true,        // mCurSector*/mLastSector*/mBestLapSector* (player)
            car_setup: true,      // mRearBrakeBias + wheel mPressure; ABS/TC left None (session-setting only)
            spectator: false,     // no spectated-car source decoded
            pit_info: self.extended.is_some(), // mCurrentPitSpeedLimit (Extended) + mPitLapDist (Scoring)
        }
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        // Poll-based source: pause briefly rather than busy-spin, then copy.
        std::thread::sleep(POLL_SLEEP);

        let telemetry = self.telemetry.as_ref()?;

        // Cheap version peek (single bounds-checked 4-byte read, no copy)
        // before paying for the full-buffer memcpy below. The poll loop wakes
        // at ~200Hz but LMU physics only advances ~50-90Hz, so most wakeups
        // would otherwise memcpy a several-hundred-vehicle buffer for
        // nothing. `version()` reads the same `mVersionUpdateEnd` counter
        // that `copy_frame` returns, so this dedup check is equivalent to
        // the post-copy one it replaces.
        let peeked_version = telemetry.version()?;
        if self.last_tele_version == Some(peeked_version) {
            return None;
        }

        let tele_version = telemetry.copy_frame(&mut self.tele_buf)?;

        // Skip frames the sim hasn't advanced, so we don't re-emit duplicates at
        // the poll rate (mirrors the iRacing no-event dedup). Kept as a
        // belt-and-suspenders check: `copy_frame`'s coherency retry can settle
        // on a version different from the racy `peeked_version` above.
        if self.last_tele_version == Some(tele_version) {
            return None;
        }

        // Scoring and Extended update slowly and independently; copy
        // best-effort each time (a stale/absent Extended frame just means pit
        // fields read as unavailable this frame, not a hard failure).
        let scor_version = match self.scoring.as_ref() {
            Some(region) => region.copy_frame(&mut self.scor_buf),
            None => {
                self.scor_buf.clear();
                None
            }
        };
        if let Some(region) = self.extended.as_ref() {
            region.copy_frame(&mut self.ext_buf);
        } else {
            self.ext_buf.clear();
        }

        self.dump_once(tele_version, scor_version);

        let slow_changed = self.last_tele_version.is_none();
        self.last_tele_version = Some(tele_version);

        let tbuf = &self.tele_buf;
        let sbuf = &self.scor_buf;

        let num_vehicles = rd_i32(tbuf, tele::NUM_VEHICLES)
            .filter(|&n| n >= 0)
            .map(|n| (n as usize).min(MAX_VEHICLES))
            .unwrap_or(0);

        // Player resolution: find mIsPlayer in scoring, then match its mID to a
        // telemetry slot (never assume index 0). If scoring isn't available yet
        // (session just loading), fall back to telemetry slot 0 — the
        // already-verified single-player behavior — rather than going dark.
        let scoring_player_idx = find_scoring_player(sbuf, num_vehicles);
        let player_id = scoring_player_idx.and_then(|i| rd_i32(sbuf, scor::veh_offset(i) + scor::veh::ID));
        let tele_player_idx = player_id
            .and_then(|id| find_index_by_id(tbuf, tele::VEHICLES, tele::STRIDE, tele::veh::ID, num_vehicles, id))
            .or(Some(0));

        let tbase = tele_player_idx.map(tele::offset);

        // --- fast-path player fields (unchanged from the first-listener stage) ---
        let speed_ms = tbase.and_then(|b| rd_vec3_magnitude(tbuf, b + tele::veh::LOCAL_VEL));
        let gear = tbase.and_then(|b| rd_i32(tbuf, b + tele::veh::GEAR));
        let rpm = tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::ENGINE_RPM)).map(|v| v as f32);
        let throttle = tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::FILTERED_THROTTLE)).map(|v| v as f32);
        let brake = tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::FILTERED_BRAKE)).map(|v| v as f32);
        let clutch = tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::FILTERED_CLUTCH)).map(|v| v as f32);
        let filtered_steering = tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::FILTERED_STEERING)).map(|v| v as f32);
        let lap = tbase.and_then(|b| rd_i32(tbuf, b + tele::veh::LAP_NUMBER));

        // --- new player fields ---
        let wheel_range_deg = tbase.and_then(|b| rd_f32(tbuf, b + tele::veh::PHYSICAL_STEERING_WHEEL_RANGE));
        // mFilteredSteering is -1..1 "left to right" per the struct comment;
        // PlayerState::steering_rad is documented as "positive = left". Applied
        // literally (no sign flip) per the task spec — 🧪 NEEDS LIVE
        // CALIBRATION: flip the sign here if a live wheel test shows the Dash
        // Cluster steering indicator turning the wrong way.
        let steering_rad = match (filtered_steering, wheel_range_deg) {
            (Some(s), Some(range)) if range > 0.0 => Some((s * (range / 2.0)).to_radians()),
            _ => None,
        };
        let fuel_l = tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::FUEL)).map(|v| v as f32);
        let rear_brake_bias = tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::REAR_BRAKE_BIAS));
        let brake_bias_pct = rear_brake_bias.map(|r| (1.0 - r as f32).clamp(0.0, 1.0));
        let ers_pct = tbase
            .and_then(|b| rd_f64(tbuf, b + tele::veh::BATTERY_CHARGE_FRACTION))
            .map(|v| (v as f32).clamp(0.0, 1.0));
        let tire_pressures = TirePressures {
            lf_kpa: tbase.and_then(|b| rd_f64(tbuf, tele::veh::wheel::offset(b, 0, tele::veh::wheel::PRESSURE))).map(|v| v as f32),
            rf_kpa: tbase.and_then(|b| rd_f64(tbuf, tele::veh::wheel::offset(b, 1, tele::veh::wheel::PRESSURE))).map(|v| v as f32),
            lr_kpa: tbase.and_then(|b| rd_f64(tbuf, tele::veh::wheel::offset(b, 2, tele::veh::wheel::PRESSURE))).map(|v| v as f32),
            rr_kpa: tbase.and_then(|b| rd_f64(tbuf, tele::veh::wheel::offset(b, 3, tele::veh::wheel::PRESSURE))).map(|v| v as f32),
        };
        // rF2 exposes no live current-lap-time field; derive it from the
        // player's telemetry clock instead (both fields come from the SAME
        // vehicle record, so this is a real measurement, not a fabrication).
        let current_lap_s = match (
            tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::ELAPSED_TIME)),
            tbase.and_then(|b| rd_f64(tbuf, b + tele::veh::LAP_START_ET)),
        ) {
            (Some(elapsed), Some(start)) if elapsed >= start && elapsed - start < 3600.0 => Some((elapsed - start) as f32),
            _ => None,
        };

        // --- player scoring-derived fields ---
        let sbase = scoring_player_idx.map(scor::veh_offset);
        let player_place = sbase.and_then(|b| rd_u8(sbuf, b + scor::veh::PLACE)).filter(|&p| p > 0);
        let position = player_place.map(|p| p as u32);
        let player_lap_dist = sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::LAP_DIST));
        let track_length_m = if sbuf.is_empty() {
            None
        } else {
            rd_f64(sbuf, scor::SCORING_INFO + scor::info::LAP_DIST)
        };
        let lap_dist_pct = match (player_lap_dist, track_length_m) {
            (Some(d), Some(len)) if len > 0.0 => Some((d / len).clamp(0.0, 1.0) as f32),
            _ => None,
        };
        let last_lap_s = lap_time(sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::LAST_LAP_TIME)));
        let best_lap_s = lap_time(sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::BEST_LAP_TIME)));
        let sector_times_s = sectors_from_cumulative(
            sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::CUR_SECTOR1)),
            sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::CUR_SECTOR2)),
            None, // the in-progress lap has no total yet
        );
        let best_lap_sector1 = sbase.and_then(|b| rd_f32(sbuf, b + scor::veh::BEST_LAP_SECTOR1)).map(f64::from);
        let best_lap_sector2 = sbase.and_then(|b| rd_f32(sbuf, b + scor::veh::BEST_LAP_SECTOR2)).map(f64::from);
        let sector_best_s = sectors_from_cumulative(
            best_lap_sector1,
            best_lap_sector2,
            sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::BEST_LAP_TIME)),
        );
        let car_name = sbase.and_then(|b| rd_cstr(sbuf, b + scor::veh::VEHICLE_NAME, scor::veh::VEHICLE_NAME_LEN));

        // Pit-box distance: mPitLapDist (stall location) vs the player's own
        // mLapDist, both in meters around the track; fold to the shortest arc.
        let pit_box_dist_m = match (
            sbase.and_then(|b| rd_f32(sbuf, b + scor::veh::PIT_LAP_DIST)).map(f64::from),
            player_lap_dist,
            track_length_m,
        ) {
            (Some(stall), Some(pos), Some(len)) if len > 0.0 => {
                let mut d = stall - pos;
                if d > len / 2.0 {
                    d -= len;
                } else if d < -len / 2.0 {
                    d += len;
                }
                Some(d as f32)
            }
            _ => None,
        };

        // --- weather / session-level scoring fields ---
        let info = scor::SCORING_INFO;
        let scoring_present = !sbuf.is_empty();
        let track_name = if scoring_present {
            rd_cstr(sbuf, info + scor::info::TRACK_NAME, scor::info::TRACK_NAME_LEN)
        } else {
            None
        };
        let session_type = if scoring_present {
            rd_i32(sbuf, info + scor::info::SESSION).and_then(session_label).map(str::to_string)
        } else {
            None
        };
        let current_et = if scoring_present { rd_f64(sbuf, info + scor::info::CURRENT_ET) } else { None };
        let end_et = if scoring_present { rd_f64(sbuf, info + scor::info::END_ET) } else { None };
        let time_remaining_s = match (current_et, end_et) {
            (Some(cur), Some(end)) if end > 0.0 => Some((end - cur).max(0.0)),
            _ => None,
        };
        let max_laps = if scoring_present { rd_i32(sbuf, info + scor::info::MAX_LAPS) } else { None };
        let laps_remaining = match (max_laps, lap) {
            (Some(m), Some(cur)) if m > 0 => Some((m - cur).max(0)),
            _ => None,
        };
        let game_phase = if scoring_present { rd_u8(sbuf, info + scor::info::GAME_PHASE) } else { None };
        let yellow_flag_state = if scoring_present { rd_i8(sbuf, info + scor::info::YELLOW_FLAG_STATE) } else { None };
        let sector_flags: [Option<i8>; 3] = [
            if scoring_present { rd_i8(sbuf, info + scor::info::SECTOR_FLAG) } else { None },
            if scoring_present { rd_i8(sbuf, info + scor::info::SECTOR_FLAG + 1) } else { None },
            if scoring_present { rd_i8(sbuf, info + scor::info::SECTOR_FLAG + 2) } else { None },
        ];
        let player_flag = sbase.and_then(|b| rd_u8(sbuf, b + scor::veh::FLAG));
        let flag = flag_from_rf2(game_phase, yellow_flag_state, sector_flags, player_flag);

        let air_temp_c = if scoring_present { rd_f64(sbuf, info + scor::info::AMBIENT_TEMP).map(|v| v as f32) } else { None };
        let track_temp_c = if scoring_present { rd_f64(sbuf, info + scor::info::TRACK_TEMP).map(|v| v as f32) } else { None };
        let wind = if scoring_present { rd_vec3(sbuf, info + scor::info::WIND) } else { None };
        let wind_speed_ms = wind.map(|(x, y, z)| ((x * x + y * y + z * z).sqrt()) as f32);
        // Axis assumption for wind bearing is unverified (🧪) — see the same
        // caveat as `world_to_local_xz`; atan2(x, z) picked as a placeholder
        // convention.
        let wind_dir_rad = wind.map(|(x, _, z)| z.atan2(x) as f32);
        let track_wetness_pct = if scoring_present {
            rd_f64(sbuf, info + scor::info::MAX_PATH_WETNESS).map(|v| (v as f32).clamp(0.0, 1.0))
        } else {
            None
        };
        let precipitation_pct = if scoring_present {
            rd_f64(sbuf, info + scor::info::RAINING).map(|v| (v as f32).clamp(0.0, 1.0))
        } else {
            None
        };

        // --- per-session state reset on track change ---
        // Inlined (rather than `self.reset_session_state()`) so this only
        // touches disjoint fields — `sbuf`/`tbuf` above hold immutable borrows
        // of `self.scor_buf`/`self.tele_buf` that are still live for the reads
        // below, and a whole-`self` method call would conflict with that even
        // though the touched fields don't overlap.
        if track_name != self.prev_track_name {
            self.fuel_history.clear();
            self.prev_lap = None;
            self.prev_fuel = None;
            self.prev_flag = FlagState::None;
            self.messages.clear();
            self.prev_track_name = track_name.clone();
        }

        // --- fuel-per-lap history (mutate only after all buffer reads above) ---
        if let Some(cur_lap) = lap {
            if self.prev_lap.is_some() && Some(cur_lap) != self.prev_lap {
                if let Some(cur_f) = fuel_l {
                    self.fuel_history.push((cur_lap, cur_f));
                    if self.fuel_history.len() > 20 {
                        self.fuel_history.remove(0);
                    }
                }
            }
            self.prev_lap = Some(cur_lap);
        }
        self.prev_fuel = fuel_l;
        let fuel_per_lap = self.fuel_per_lap();

        Self::on_flag_changed(&mut self.messages, &mut self.prev_flag, flag);

        let player = PlayerState {
            speed_ms,
            rpm,
            gear,
            throttle,
            brake,
            clutch,
            steering_rad,
            lap_dist_pct,
            fuel_l,
            fuel_per_lap_l: fuel_per_lap,
            lap,
            current_lap_s,
            last_lap_s,
            best_lap_s,
            delta_best_s: None,         // no live distance-indexed delta computed
            delta_session_best_s: None, // ditto
            position,
            class_position: None, // filled below once `cars[]` positions are known
            car_idx: player_id.map(|id| id.max(0) as u32),
            car_name,
            on_track: None, // rF2 exposes no clean "driving vs garage" bool we can trust here
            in_garage: None,
            car_left: None,  // no CarLeftRight-style spotter signal in these buffers
            car_right: None,
            pit_speed_limit_ms: self.pit_speed_limit(),
            pit_box_dist_m,
            sector_times_s,
            sector_best_s,
            brake_bias_pct,
            abs_active: None, // rF2 exposes ABS/TC only as session SETTINGS (Extended physics options), not live per-frame
            tc_active: None,
            drs_state: None, // no DRS concept surfaced in these buffers
            ers_pct,
            fuel_mix: None,
            p2p_available: None,
            tire_pressures,
        };

        // --- field (cars[]) from the scoring array ---
        let mut classes: Vec<Option<String>> = Vec::with_capacity(num_vehicles);
        let mut positions: Vec<Option<u32>> = Vec::with_capacity(num_vehicles);
        struct Raw {
            id: Option<i32>,
            driver_name: Option<String>,
            car_screen_name: Option<String>,
            lap: Option<i32>,
            lap_dist: Option<f64>,
            last_lap_s: Option<f32>,
            best_lap_s: Option<f32>,
            on_pit_road: Option<bool>,
            control: Option<i8>,
            in_garage_stall: Option<bool>,
            time_into_lap: Option<f64>,
            estimated_lap_time: Option<f64>,
            /// World position, for the radar transform (via the PLAYER's
            /// orientation — this car's own `mOri` isn't needed for that).
            pos: Option<(f64, f64, f64)>,
            pit_state: Option<u8>,
        }
        let mut raws: Vec<Raw> = Vec::with_capacity(num_vehicles);
        for i in 0..num_vehicles {
            let b = scor::veh_offset(i);
            let class_name = rd_cstr(sbuf, b + scor::veh::VEHICLE_CLASS, scor::veh::VEHICLE_CLASS_LEN);
            let place = rd_u8(sbuf, b + scor::veh::PLACE).filter(|&p| p > 0).map(|p| p as u32);
            classes.push(class_name);
            positions.push(place);
            raws.push(Raw {
                id: rd_i32(sbuf, b + scor::veh::ID),
                driver_name: rd_cstr(sbuf, b + scor::veh::DRIVER_NAME, scor::veh::DRIVER_NAME_LEN),
                car_screen_name: rd_cstr(sbuf, b + scor::veh::VEHICLE_NAME, scor::veh::VEHICLE_NAME_LEN),
                // `mTotalLaps` is a `short` (2 bytes), not a `long` — read it
                // with `rd_i16`, not `rd_i32` (which would consume 2 bytes of
                // the following `mSector`/`mFinishStatus` fields too).
                lap: rd_i16(sbuf, b + scor::veh::TOTAL_LAPS).map(i32::from),
                lap_dist: rd_f64(sbuf, b + scor::veh::LAP_DIST),
                last_lap_s: lap_time(rd_f64(sbuf, b + scor::veh::LAST_LAP_TIME)),
                best_lap_s: lap_time(rd_f64(sbuf, b + scor::veh::BEST_LAP_TIME)),
                on_pit_road: rd_bool(sbuf, b + scor::veh::IN_PITS),
                control: rd_i8(sbuf, b + scor::veh::CONTROL),
                in_garage_stall: rd_bool(sbuf, b + scor::veh::IN_GARAGE_STALL),
                time_into_lap: rd_f64(sbuf, b + scor::veh::TIME_INTO_LAP),
                estimated_lap_time: rd_f64(sbuf, b + scor::veh::ESTIMATED_LAP_TIME),
                pos: rd_vec3(sbuf, b + scor::veh::POS),
                pit_state: rd_u8(sbuf, b + scor::veh::PIT_STATE),
            });
        }
        let class_pos = class_positions(&classes, &positions);

        // Reference lap length for folding relative gaps: prefer the player's
        // own estimated lap time, fall back to their best/last lap.
        let player_time_into_lap = sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::TIME_INTO_LAP));
        let player_est_lap_time = sbase.and_then(|b| rd_f64(sbuf, b + scor::veh::ESTIMATED_LAP_TIME));
        let lap_len_s = player_est_lap_time
            .map(|v| v as f32)
            .filter(|&l| l.is_finite() && l > 1.0)
            .or(best_lap_s)
            .or(last_lap_s);

        let player_pos_ori = match (sbase.and_then(|b| rd_vec3(sbuf, b + scor::veh::POS)), sbase.and_then(|b| read_ori(sbuf, b + scor::veh::ORI))) {
            (Some(p), Some(o)) => Some((p, o)),
            _ => None,
        };

        let cars: Vec<CarState> = raws
            .into_iter()
            .enumerate()
            .map(|(i, r)| {
                let gap_to_player_s = match (r.time_into_lap, player_time_into_lap) {
                    (Some(t), Some(p)) => Some(wrap_gap((t - p) as f32, lap_len_s.or(r.estimated_lap_time.map(|v| v as f32)))),
                    _ => None,
                };
                let (rel_lat_m, rel_lon_m) = match (player_pos_ori, r.pos) {
                    (Some((pp, po)), Some(cp)) => {
                        let (x, z) = world_to_local_xz(pp, po, cp);
                        // rF2 local axes are X=+left, Z=+rear; our convention is
                        // rel_lat=+right / rel_lon=+ahead, so both are negated
                        // (lateral confirmed by live radar: a car on the right
                        // was reading left until this flip).
                        (Some(-x), Some(-z))
                    }
                    _ => (None, None),
                };
                let in_world = r.control.map(|c| c >= 0 && !r.in_garage_stall.unwrap_or(false));
                CarState {
                    car_idx: r.id.map(|v| v.max(0) as u32).unwrap_or(i as u32),
                    driver_name: r.driver_name,
                    car_screen_name: r.car_screen_name,
                    car_class_id: None, // rF2 has no numeric class id, only the name
                    car_class_name: classes[i].clone(),
                    class_color: classes[i].as_deref().map(class_color_from_name),
                    car_number: None, // not exposed per car in this buffer
                    country: None,
                    positions_gained: None,
                    irating_delta: None,
                    tyre: None,
                    position: positions[i],
                    class_position: class_pos[i],
                    lap: r.lap,
                    lap_dist_pct: match (r.lap_dist, track_length_m) {
                        (Some(d), Some(len)) if len > 0.0 => Some((d / len).clamp(0.0, 1.0) as f32),
                        _ => None,
                    },
                    gap_to_player_s,
                    last_lap_s: r.last_lap_s,
                    best_lap_s: r.best_lap_s,
                    on_pit_road: r.on_pit_road,
                    in_world,
                    irating: None,
                    safety_rating: None,
                    rel_lat_m,
                    rel_lon_m,
                    pit_status: r.pit_state.map(u32::from),
                    has_session_fastest: None,
                }
            })
            .collect();

        let mut player = player;
        player.class_position = scoring_player_idx.and_then(|i| class_pos.get(i).copied().flatten());

        let session = SessionState {
            track_name,
            session_type,
            time_remaining_s,
            laps_remaining,
            total_cars: Some(num_vehicles as u32),
            flags_raw: None, // rF2 has no single bitfield analogous to iRacing's SessionFlags
            flag,
            air_temp_c,
            track_temp_c,
            wind_speed_ms,
            wind_dir_rad,
            track_wetness_pct,
            precipitation_pct,
            humidity_pct: None, // not exposed by rF2
            spectated_car_idx: None,
            messages: self.messages.clone(),
            chat_messages: Vec::new(),
            track_path: None,     // no baked LMU centerline source (deferred)
            track_turns: None,
            track_metadata: None,
        };

        Some(TelemetrySnapshot {
            meta: Meta {
                sim: SimId::Lmu,
                tick: 0,                // stamped by the reader
                frame_timestamp_s: 0.0, // stamped by the reader
                sim_tick: Some(tele_version as i64),
                changed: ChangeFlags {
                    fast: true,
                    slow: slow_changed,
                },
            },
            session,
            player,
            cars,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- flag mapping ---

    #[test]
    fn flag_priority_checkered_beats_everything() {
        assert_eq!(flag_from_rf2(Some(8), Some(7), [Some(1), None, None], Some(6)), FlagState::Checkered);
    }

    #[test]
    fn flag_red_from_game_phase_or_yellow_state() {
        assert_eq!(flag_from_rf2(Some(7), None, [None; 3], None), FlagState::Red);
        assert_eq!(flag_from_rf2(Some(0), Some(7), [None; 3], None), FlagState::Red);
    }

    #[test]
    fn flag_yellow_from_game_phase_or_exact_sector_flag() {
        assert_eq!(flag_from_rf2(Some(6), None, [None; 3], None), FlagState::Yellow);
        // Only an EXACT 1 counts as "local yellow" for a sector — see doc.
        assert_eq!(flag_from_rf2(Some(5), Some(0), [Some(0), Some(1), Some(0)], None), FlagState::Yellow);
    }

    #[test]
    fn flag_yellow_from_yellow_flag_state_caution_range() {
        // mYellowFlagState is the authoritative full-course-caution signal:
        // every value 1..=6 is some caution phase and must yield Yellow,
        // independent of mGamePhase/sector flags.
        for v in 1..=6 {
            assert_eq!(
                flag_from_rf2(Some(1), Some(v), [None; 3], None),
                FlagState::Yellow,
                "yellow_flag_state={v} should decode to Yellow"
            );
        }
    }

    #[test]
    fn flag_sector_flag_rejects_non_one_values_as_noise() {
        // This is the regression test for the "always yellow" bug: a
        // non-zero-but-not-1 sector-flag byte (as a garbage/uncalibrated read
        // would produce) must NOT trigger Yellow. With no other flag set (and
        // the green-flag phase mapping to None), the honest result is None.
        assert_eq!(
            flag_from_rf2(Some(5), Some(0), [Some(2), Some(-5), Some(127)], None),
            FlagState::None
        );
    }

    #[test]
    fn flag_blue_only_from_player_flag() {
        assert_eq!(flag_from_rf2(Some(5), Some(0), [Some(0); 3], Some(6)), FlagState::Blue);
        // Green-flag phase on-track and no blue -> None (widget hidden), not
        // Blue. The green phase is deliberately NOT surfaced as a standing flag.
        assert_eq!(flag_from_rf2(Some(5), Some(0), [Some(0); 3], Some(0)), FlagState::None);
    }

    #[test]
    fn flag_green_phase_is_none_not_a_standing_flag() {
        // A completely clean/valid green session: game_phase=5 (green-flag
        // phase), yellow_flag_state=0 (none), all sector flags 0 (no local
        // yellow). rF2 holds mGamePhase==5 for the ENTIRE green stint, so
        // surfacing it as a flag would light the widget all race — the honest,
        // iRacing-consistent result is None (widget hidden).
        assert_eq!(flag_from_rf2(Some(5), Some(0), [Some(0); 3], None), FlagState::None);
    }

    #[test]
    fn flag_none_when_nothing_matches() {
        assert_eq!(flag_from_rf2(Some(0), Some(0), [Some(0); 3], Some(0)), FlagState::None);
        assert_eq!(flag_from_rf2(None, None, [None; 3], None), FlagState::None);
    }

    #[test]
    fn flag_out_of_range_garbage_never_produces_yellow() {
        // Simulates a torn/garbage read from an unverified offset (see the
        // pointer-size caveat on `crate::rf2::scor::info`): mGamePhase and
        // mYellowFlagState outside their documented enum ranges, and
        // sector-flag bytes that are non-zero but not the documented "1"
        // value. All of it must be ignored, never folded into Yellow — honest
        // None beats a fabricated flag.
        assert_eq!(
            flag_from_rf2(Some(200), Some(99), [Some(-100), Some(45), Some(2)], None),
            FlagState::None
        );
        assert_eq!(
            flag_from_rf2(Some(255), Some(-50), [Some(7), Some(3), Some(-1)], Some(0)),
            FlagState::None
        );
    }

    // --- sentinel lap-time filtering ---

    #[test]
    fn lap_time_filters_sentinel() {
        assert_eq!(lap_time(Some(-1.0)), None);
        assert_eq!(lap_time(Some(0.0)), None);
        assert_eq!(lap_time(Some(87.654)), Some(87.654));
        assert_eq!(lap_time(None), None);
    }

    // --- cumulative-sector subtraction ---

    #[test]
    fn sectors_from_cumulative_splits_correctly() {
        // S1=30.0, S1+S2=52.5 (S2=22.5), no lap total yet -> S3 unknown.
        let s = sectors_from_cumulative(Some(30.0), Some(52.5), None);
        assert_eq!(s.s1, Some(30.0));
        assert!((s.s2.unwrap() - 22.5).abs() < 1e-4);
        assert_eq!(s.s3, None);

        // Full lap: S1=30, S1+S2=52.5, lap total=90 -> S3=37.5.
        let full = sectors_from_cumulative(Some(30.0), Some(52.5), Some(90.0));
        assert!((full.s3.unwrap() - 37.5).abs() < 1e-4);
    }

    #[test]
    fn sectors_from_cumulative_rejects_sentinels_and_nonincreasing() {
        // Sector 1 not yet set (sentinel).
        let s = sectors_from_cumulative(Some(-1.0), None, None);
        assert_eq!(s.s1, None);
        assert_eq!(s.s2, None);

        // Non-increasing cumulative (torn/garbage read) -> None, not negative.
        let bad = sectors_from_cumulative(Some(40.0), Some(35.0), None);
        assert_eq!(bad.s2, None);
    }

    // --- wrap_gap (mirrors the iRacing connector's equivalent test) ---

    #[test]
    fn wrap_gap_folds_across_start_finish() {
        let g = wrap_gap(88.0, Some(90.0));
        assert!((g + 2.0).abs() < 1e-3, "expected ~-2, got {g}");
        let g2 = wrap_gap(-88.0, Some(90.0));
        assert!((g2 - 2.0).abs() < 1e-3, "expected ~+2, got {g2}");
    }

    #[test]
    fn wrap_gap_no_lap_len_is_identity() {
        assert!((wrap_gap(50.0, None) - 50.0).abs() < 1e-4);
    }

    // --- player-by-mID matching (synthetic multi-vehicle buffers) ---

    /// Build a minimal synthetic telemetry buffer with `n` vehicles, each with
    /// only `mID` set (at the real `tele::veh::ID` offset / `tele::STRIDE`),
    /// so the ID-matching scan is exercised against the real offset math
    /// without needing a full 1888-byte-per-vehicle fixture.
    fn synthetic_tele_buf(ids: &[i32]) -> Vec<u8> {
        let mut buf = vec![0u8; tele::VEHICLES + ids.len() * tele::STRIDE];
        for (i, &id) in ids.iter().enumerate() {
            let off = tele::offset(i) + tele::veh::ID;
            buf[off..off + 4].copy_from_slice(&id.to_le_bytes());
        }
        buf
    }

    fn synthetic_scor_buf(player_idx: usize, ids: &[i32]) -> Vec<u8> {
        let mut buf = vec![0u8; scor::VEHICLES + ids.len() * scor::VEH_STRIDE];
        for (i, &id) in ids.iter().enumerate() {
            let base = scor::veh_offset(i);
            buf[base + scor::veh::ID..base + scor::veh::ID + 4].copy_from_slice(&id.to_le_bytes());
            if i == player_idx {
                buf[base + scor::veh::IS_PLAYER] = 1;
            }
        }
        buf
    }

    #[test]
    fn finds_player_by_id_not_by_index() {
        // Player is NOT slot 0 in either buffer, and the IDs are shuffled
        // between telemetry and scoring order (mirrors "player is not
        // telemetry index 0" from the plugin's own docs).
        let scor_ids = [301, 302, 303];
        let tele_ids = [303, 301, 302]; // same cars, different slot order
        let scor_buf = synthetic_scor_buf(1, &scor_ids); // player = id 302
        let tele_buf = synthetic_tele_buf(&tele_ids);

        let player_scor_idx = find_scoring_player(&scor_buf, scor_ids.len()).unwrap();
        assert_eq!(player_scor_idx, 1);
        let player_id = rd_i32(&scor_buf, scor::veh_offset(player_scor_idx) + scor::veh::ID).unwrap();
        assert_eq!(player_id, 302);

        let tele_idx = find_index_by_id(&tele_buf, tele::VEHICLES, tele::STRIDE, tele::veh::ID, tele_ids.len(), player_id);
        assert_eq!(tele_idx, Some(2), "id 302 is telemetry slot 2, not scoring slot 1 or tele slot 0");
    }

    #[test]
    fn player_lookup_absent_when_no_scoring_data() {
        assert_eq!(find_scoring_player(&[], 0), None);
    }

    // --- class_positions ---

    #[test]
    fn class_positions_rank_within_group_only() {
        let classes = vec![Some("GT3".to_string()), Some("LMP2".to_string()), Some("GT3".to_string()), None];
        let positions = vec![Some(3), Some(1), Some(5), Some(2)];
        let ranks = class_positions(&classes, &positions);
        // GT3 field: idx0 (pos3) then idx2 (pos5) -> ranks 1, 2.
        assert_eq!(ranks[0], Some(1));
        assert_eq!(ranks[2], Some(2));
        // LMP2 field: only idx1 -> rank 1.
        assert_eq!(ranks[1], Some(1));
        // No class -> no rank.
        assert_eq!(ranks[3], None);
    }

    // A trivial sanity check that rd_i16 (used nowhere above directly because
    // mTotalLaps is currently read defensively — see the `Raw.lap` TODO) at
    // least round-trips, so a future switch to it is safe.
    #[test]
    fn i16_roundtrip_sanity() {
        let mut buf = vec![0u8; 4];
        buf[0..2].copy_from_slice(&42i16.to_le_bytes());
        assert_eq!(rd_i16(&buf, 0), Some(42));
    }
}
