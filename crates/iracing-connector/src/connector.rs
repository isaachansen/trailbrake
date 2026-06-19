//! `IRacingConnector`: implements [`SimConnector`] over the irsdk shared memory.

use std::collections::HashMap;

use overlay_core::{
    Capabilities, ChangeFlags, ConnectError, Meta, PlayerState, RaceControlMessage, Sectors,
    SessionState, SimConnector, SimId, TelemetrySnapshot, TirePressures,
};

use crate::irsdk::header::{build_var_map, Header};
use crate::irsdk::mmap::{MappedFile, WaitResult};
use crate::irsdk::var::VarDef;
use crate::irsdk::{
    DATA_VALID_EVENT_NAME, HEADER_LEN, MEM_MAP_NAME, STATUS_CONNECTED, VAR_HEADER_LEN,
};
use crate::session::{decode_session_info, parse_min, SessionInfoMin};
use crate::track_map;

/// Wait budget for the data-ready event. Long enough to block (no busy-spin),
/// short enough to notice disconnects / honor shutdown promptly.
const WAIT_TIMEOUT_MS: u32 = 32;

/// iRacing session flags (subset of `irsdk_Flags`) the Race Control widget
/// decodes. Source: iRacing SDK `irsdk_Flags` constants.
mod ir_flags {
    pub const GREEN: u32 = 0x01;
    pub const YELLOW: u32 = 0x02;
    pub const CHECKERED: u32 = 0x04;
    pub const WHITE: u32 = 0x08;
    pub const BLACK: u32 = 0x10;
    pub const BLACKWHITE: u32 = 0x20;
    pub const BLUE: u32 = 0x40;
    pub const RED: u32 = 0x80;
    pub const DEBRIS: u32 = 0x100;
    pub const CROSSED: u32 = 0x200;
    pub const YELLOWWAVING: u32 = 0x400;
    pub const ONEBLACK: u32 = 0x800;
    pub const GREENWHITE: u32 = 0x1000;
}

pub struct IRacingConnector {
    map: Option<MappedFile>,
    /// `name -> VarDef`, rebuilt once per session.
    var_map: HashMap<String, VarDef>,
    /// Last seen `sessionInfoUpdate`; a change triggers a var-map + YAML rebuild.
    last_session_update: i32,
    session_min: SessionInfoMin,
    /// Reused buffer-row copy, to avoid a per-frame allocation.
    scratch: Vec<u8>,
    /// Fuel-history ring for deriving `fuel_per_lap_l`. Each entry is
    /// `(lap_number, fuel_at_lap_crossing_l)`.
    fuel_history: Vec<(i32, f32)>,
    /// Previous lap number, for detecting lap crossings.
    prev_lap: Option<i32>,
    /// Previous fuel level, for capturing per-lap burn at lap crossing.
    prev_fuel: Option<f32>,
    /// Previous flags, for generating race-control messages on flag changes.
    prev_flags: u32,
    /// Accumulated race-control messages (bounded).
    messages: Vec<RaceControlMessage>,
}

/// Copy the freshest telemetry buffer into `scratch`, with a simple torn-frame
/// guard: if the freshest buffer's `tickCount` changes across the copy, the sim
/// swapped buffers mid-read, so we retry. Returns the `tickCount` of the copied
/// frame.
///
/// Free function (not a method) so the caller can hold `&self.map` and
/// `&mut self.scratch` as disjoint borrows of the connector at the same time.
fn fill_latest_buffer(map: &MappedFile, scratch: &mut Vec<u8>) -> Option<i64> {
    let mut last_tick = 0i32;
    for _ in 0..4 {
        // SAFETY: header prefix is always present in the region.
        let h = Header::parse(unsafe { map.slice(0, HEADER_LEN) })?;
        if h.buf_len == 0 {
            return None;
        }
        let vb = *h.latest_buf();
        last_tick = vb.tick_count;

        // SAFETY: bounds come from the header the sim wrote.
        let src = unsafe { map.slice(vb.buf_offset, h.buf_len) };
        scratch.clear();
        scratch.extend_from_slice(src);

        let h2 = Header::parse(unsafe { map.slice(0, HEADER_LEN) })?;
        if h2.latest_buf().tick_count == vb.tick_count {
            return Some(vb.tick_count as i64);
        }
    }
    // Gave up after retries; return best-effort copy.
    Some(last_tick as i64)
}

// SAFETY: `MappedFile` holds a raw pointer into the mapped region, which makes
// the connector `!Send` by default. The reader moves the connector onto its own
// thread exactly once and never shares it; all access is single-threaded
// thereafter. So it is sound to mark it `Send`.
unsafe impl Send for IRacingConnector {}

impl Default for IRacingConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl IRacingConnector {
    pub fn new() -> Self {
        Self {
            map: None,
            var_map: HashMap::new(),
            last_session_update: i32::MIN,
            session_min: SessionInfoMin::default(),
            scratch: Vec::new(),
            fuel_history: Vec::new(),
            prev_lap: None,
            prev_fuel: None,
            prev_flags: 0,
            messages: Vec::new(),
        }
    }

    /// Compute fuel-per-lap from the history of `(lap, fuel_at_crossing)` pairs.
    /// Uses the last 5 laps' burn values, taking the average of the valid ones.
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

    /// Detect a flag change and append a race-control message describing it.
    /// Takes only the fields it needs so it can be called while `self.var_map`
    /// is immutably borrowed (disjoint field borrow).
    fn on_flags_changed(
        messages: &mut Vec<RaceControlMessage>,
        prev_flags: &mut u32,
        new_flags: u32,
    ) {
        if new_flags == *prev_flags {
            return;
        }
        let now_s = None; // iRacing doesn't expose a session clock for messages
        let changed = new_flags ^ *prev_flags;
        let mut push = |kind: &str, text: &str, prio: u32| {
            messages.push(RaceControlMessage {
                time_s: now_s,
                kind: kind.to_string(),
                text: text.to_string(),
                priority: prio,
            });
        };
        // Raised flags (newly set bits).
        if changed & ir_flags::GREEN != 0 && new_flags & ir_flags::GREEN != 0 {
            push("flag", "Green flag — session resumed", 10);
        }
        if changed & ir_flags::YELLOW != 0 && new_flags & ir_flags::YELLOW != 0 {
            push("flag", "Yellow flag — caution", 20);
        }
        if changed & ir_flags::RED != 0 && new_flags & ir_flags::RED != 0 {
            push("flag", "Red flag — session stopped", 30);
        }
        if changed & ir_flags::CHECKERED != 0 && new_flags & ir_flags::CHECKERED != 0 {
            push("flag", "Checkered flag — session over", 40);
        }
        if changed & ir_flags::WHITE != 0 && new_flags & ir_flags::WHITE != 0 {
            push("flag", "White flag — last lap", 15);
        }
        if changed & ir_flags::BLUE != 0 && new_flags & ir_flags::BLUE != 0 {
            push("flag", "Blue flag — leaders approaching", 12);
        }
        if changed & ir_flags::BLACK != 0 && new_flags & ir_flags::BLACK != 0 {
            push("penalty", "Black flag — penalty", 25);
        }
        // Trim to a reasonable window.
        if messages.len() > 50 {
            let drop = messages.len() - 50;
            messages.drain(0..drop);
        }
        *prev_flags = new_flags;
    }
}

// --- small read helpers over the copied buffer + var map ---

fn f32_var(map: &HashMap<String, VarDef>, buf: &[u8], name: &str) -> Option<f32> {
    map.get(name).and_then(|d| d.read_f32(buf, 0))
}

fn f64_var(map: &HashMap<String, VarDef>, buf: &[u8], name: &str) -> Option<f64> {
    map.get(name).and_then(|d| d.read_f64(buf, 0))
}

fn i32_var(map: &HashMap<String, VarDef>, buf: &[u8], name: &str) -> Option<i32> {
    map.get(name).and_then(|d| d.read_i32(buf, 0))
}

fn u32_var(map: &HashMap<String, VarDef>, buf: &[u8], name: &str) -> Option<u32> {
    map.get(name).and_then(|d| d.read_u32(buf, 0))
}

// --- array (`CarIdx*`) reads at a specific car index ---

fn f32_at(map: &HashMap<String, VarDef>, buf: &[u8], name: &str, idx: usize) -> Option<f32> {
    map.get(name).and_then(|d| d.read_f32(buf, idx))
}
fn i32_at(map: &HashMap<String, VarDef>, buf: &[u8], name: &str, idx: usize) -> Option<i32> {
    map.get(name).and_then(|d| d.read_i32(buf, idx))
}
fn u32_at(map: &HashMap<String, VarDef>, buf: &[u8], name: &str, idx: usize) -> Option<u32> {
    map.get(name).and_then(|d| d.read_u32(buf, idx))
}
fn bool_at(map: &HashMap<String, VarDef>, buf: &[u8], name: &str, idx: usize) -> Option<bool> {
    map.get(name).and_then(|d| d.read_bool(buf, idx))
}

/// iRacing reports lap times as `-1` when not yet set; map those to `None`.
fn lap_time(v: Option<f32>) -> Option<f32> {
    v.filter(|&t| t > 0.0)
}

/// Position `0` means "not in a session / invalid"; map to `None`.
fn position(v: Option<u32>) -> Option<u32> {
    v.filter(|&p| p > 0)
}

impl SimConnector for IRacingConnector {
    fn sim_id(&self) -> SimId {
        SimId::IRacing
    }

    fn connect(&mut self) -> Result<(), ConnectError> {
        let map = MappedFile::open(MEM_MAP_NAME, DATA_VALID_EVENT_NAME)?;
        self.map = Some(map);
        // Force a var-map/YAML rebuild on the next poll.
        self.last_session_update = i32::MIN;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.map.is_some()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            clutch: true,
            steering_angle: true,
            fuel: true,
            deltas: true,
            relative_gaps: true,
            irating: true,
            safety_rating: true,
            multiclass: true,
            proximity: false, // iRacing SDK exposes no lateral neighbour offset
            track_map: true,  // bundled official centerlines (see `track_map`)
            race_control: true, // flag changes are decoded from `SessionFlags`
            chat: false,         // no broadcast chat source wired yet
            weather: true,       // AirTemp/TrackTemp/WindVel/WindDir/precip/humidity
            sectors: true,       // LapBestLapSector1/2/3 + per-sector current times
            car_setup: true,     // BrakeBias/ABS/TC/DRS/tire pressures (car-dependent)
            spectator: true,     // CamCarIdxTarget
            pit_info: true,      // PitSpeedLimit + CarIdxPitStopStatus
        }
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        let map = self.map.as_ref()?;

        // Block on the sim's data-ready event rather than busy-polling.
        match map.wait_for_data(WAIT_TIMEOUT_MS) {
            WaitResult::Signaled => {}
            WaitResult::Timeout => return None,
            WaitResult::NoEvent => {
                // No event handle: avoid a hot spin while still staying current.
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }

        // Re-borrow `map` immutably for the header read.
        let map = self.map.as_ref()?;
        let header = Header::parse(unsafe { map.slice(0, HEADER_LEN) })?;

        // In the menus / between sessions the connected bit is clear.
        if header.status & STATUS_CONNECTED == 0 {
            return None;
        }

        // Rebuild the var map + session info only when the session changes.
        let mut session_changed = false;
        if header.session_info_update != self.last_session_update {
            let var_end = header.var_header_offset + header.num_vars * VAR_HEADER_LEN;
            // SAFETY: bounds derived from the header the sim wrote.
            let var_region = unsafe { map.slice(0, var_end) };
            self.var_map = build_var_map(var_region, &header);

            if header.session_info_len > 0 {
                let raw = unsafe { map.slice(header.session_info_offset, header.session_info_len) };
                let yaml = decode_session_info(raw);
                self.session_min = parse_min(&yaml);
            }

            self.last_session_update = header.session_info_update;
            session_changed = true;
        }

        // Snapshot the freshest buffer. `&self.map` and `&mut self.scratch` are
        // disjoint field borrows, so both can be held at once.
        let map = self.map.as_ref()?;
        let sim_tick = fill_latest_buffer(map, &mut self.scratch)?;

        // Build the normalized snapshot from the copied buffer.
        let vm = &self.var_map;
        let buf = &self.scratch;

        // iRacing's `Clutch` is 1.0 when fully engaged (pedal up) and 0.0 when
        // pressed — the inverse of our "0 released, 1 applied" pedal convention.
        let clutch = f32_var(vm, buf, "Clutch").map(|c| 1.0 - c);

        let lap = i32_var(vm, buf, "Lap");
        let fuel_l = f32_var(vm, buf, "FuelLevel");

        // Fuel-per-lap from history: detect lap crossings and record the fuel
        // level at each crossing, then average the recent burn values.
        if let Some(cur_lap) = lap {
            if self.prev_lap.is_some() && Some(cur_lap) != self.prev_lap {
                if let (Some(_prev_f), Some(cur_f)) = (self.prev_fuel, fuel_l) {
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

        // Flag-change → race-control messages. Uses disjoint field borrows so it
        // can run while `vm` is alive.
        let flags_raw = u32_var(vm, buf, "SessionFlags").unwrap_or(0);
        Self::on_flags_changed(&mut self.messages, &mut self.prev_flags, flags_raw);

        let player = PlayerState {
            speed_ms: f32_var(vm, buf, "Speed"),
            rpm: f32_var(vm, buf, "RPM"),
            gear: i32_var(vm, buf, "Gear"),
            throttle: f32_var(vm, buf, "Throttle"),
            brake: f32_var(vm, buf, "Brake"),
            clutch,
            steering_rad: f32_var(vm, buf, "SteeringWheelAngle"),
            lap_dist_pct: f32_var(vm, buf, "LapDistPct"),
            fuel_l,
            fuel_per_lap_l: fuel_per_lap,
            lap,
            current_lap_s: lap_time(f32_var(vm, buf, "LapCurrentLapTime")),
            last_lap_s: lap_time(f32_var(vm, buf, "LapLastLapTime")),
            best_lap_s: lap_time(f32_var(vm, buf, "LapBestLapTime")),
            delta_best_s: f32_var(vm, buf, "LapDeltaToBestLap"),
            delta_session_best_s: f32_var(vm, buf, "LapDeltaToSessionBestLap"),
            position: position(u32_var(vm, buf, "PlayerCarPosition")),
            class_position: position(u32_var(vm, buf, "PlayerCarClassPosition")),
            car_idx: self.session_min.driver_car_idx,
            car_name: self
                .session_min
                .driver_car_idx
                .and_then(|pi| self.session_min.drivers.iter().find(|d| d.car_idx == pi))
                .and_then(|d| d.car_screen_name.clone()),
            // iRacing's `IsOnTrack` is set while driving, clear in the garage.
            on_track: bool_at(vm, buf, "IsOnTrack", 0),
            in_garage: bool_at(vm, buf, "IsInGarage", 0),
            // iRacing `CarLeftRight` spotter enum: 2/4/5 = car(s) left, 3/4/6 = right.
            car_left: i32_var(vm, buf, "CarLeftRight").map(|v| matches!(v, 2 | 4 | 5)),
            car_right: i32_var(vm, buf, "CarLeftRight").map(|v| matches!(v, 3 | 4 | 6)),

            // Pit / setup helpers.
            pit_speed_limit_ms: f32_var(vm, buf, "PitSpeedLimit"),
            pit_box_dist_m: None, // derived below from CarIdxLapDistPct + pit stall info
            sector_times_s: Sectors {
                s1: lap_time(f32_var(vm, buf, "LapCurrentSectorTime1")),
                s2: lap_time(f32_var(vm, buf, "LapCurrentSectorTime2")),
                s3: lap_time(f32_var(vm, buf, "LapCurrentSectorTime3")),
            },
            sector_best_s: Sectors {
                s1: lap_time(f32_var(vm, buf, "LapBestLapSector1Time")),
                s2: lap_time(f32_var(vm, buf, "LapBestLapSector2Time")),
                s3: lap_time(f32_var(vm, buf, "LapBestLapSector3Time")),
            },

            // In-car settings / statuses.
            brake_bias_pct: f32_var(vm, buf, "BrakeBias").map(|v| v.clamp(0.0, 1.0)),
            abs_active: i32_var(vm, buf, "ABSActive").map(|v| v != 0),
            tc_active: i32_var(vm, buf, "TractionControl1").map(|v| v != 0),
            drs_state: i32_var(vm, buf, "DRS_Status"),
            ers_pct: f32_var(vm, buf, "ERS_Energy").map(|v| v.clamp(0.0, 1.0)),
            fuel_mix: i32_var(vm, buf, "FuelMix"),
            p2p_available: i32_var(vm, buf, "P2P_Status"),
            tire_pressures: TirePressures {
                lf_kpa: f32_var(vm, buf, "LFpressure"),
                rf_kpa: f32_var(vm, buf, "RFpressure"),
                lr_kpa: f32_var(vm, buf, "LRpressure"),
                rr_kpa: f32_var(vm, buf, "RRpressure"),
            },
        };

        // Build the field from DriverInfo (parsed on session change) + the live
        // CarIdx* arrays. Gap is approximated from CarIdxEstTime (time at each
        // car's track position) relative to the player.
        let player_est = self
            .session_min
            .driver_car_idx
            .and_then(|pi| f32_at(vm, buf, "CarIdxEstTime", pi as usize));
        let cars: Vec<overlay_core::CarState> = self
            .session_min
            .drivers
            .iter()
            .filter(|d| !d.is_pace_car)
            .map(|d| {
                let i = d.car_idx as usize;
                let est = f32_at(vm, buf, "CarIdxEstTime", i);
                let gap = match (est, player_est) {
                    (Some(e), Some(p)) => Some(e - p),
                    _ => None,
                };
                overlay_core::CarState {
                    car_idx: d.car_idx,
                    driver_name: d.user_name.clone(),
                    car_screen_name: d.car_screen_name.clone(),
                    car_class_id: d.car_class_id,
                    car_class_name: d.car_class_name.clone(),
                    class_color: d.class_color,
                    car_number: d.car_number.clone(),
                    country: d.country.clone(),
                    positions_gained: None, // TODO: derive from start position
                    irating_delta: None,    // not exposed live
                    tyre: None,             // iRacing doesn't expose compound letter per car
                    position: position(u32_at(vm, buf, "CarIdxPosition", i)),
                    class_position: position(u32_at(vm, buf, "CarIdxClassPosition", i)),
                    lap: i32_at(vm, buf, "CarIdxLap", i),
                    lap_dist_pct: f32_at(vm, buf, "CarIdxLapDistPct", i),
                    gap_to_player_s: gap,
                    last_lap_s: lap_time(f32_at(vm, buf, "CarIdxLastLapTime", i)),
                    best_lap_s: lap_time(f32_at(vm, buf, "CarIdxBestLapTime", i)),
                    on_pit_road: bool_at(vm, buf, "CarIdxOnPitRoad", i),
                    irating: d.irating,
                    safety_rating: d.license.clone(),
                    rel_lat_m: None, // not exposed by the iRacing SDK
                    rel_lon_m: None,
                    pit_status: u32_at(vm, buf, "CarIdxPitStopStatus", i),
                    has_session_fastest: None, // not directly exposed per car
                }
            })
            .collect();

        let session = SessionState {
            track_name: self.session_min.track_name.clone(),
            session_type: self.session_min.session_type.clone(),
            time_remaining_s: f64_var(vm, buf, "SessionTimeRemain"),
            laps_remaining: i32_var(vm, buf, "SessionLapsRemainEx"),
            total_cars: Some(self.session_min.drivers.len() as u32),
            flags_raw: Some(flags_raw),
            air_temp_c: f32_var(vm, buf, "AirTemp"),
            track_temp_c: f32_var(vm, buf, "TrackTemp"),
            wind_speed_ms: f32_var(vm, buf, "WindVel"),
            wind_dir_rad: f32_var(vm, buf, "WindDir"),
            track_wetness_pct: f32_var(vm, buf, "TrackWetness").map(|v| v.clamp(0.0, 1.0)),
            precipitation_pct: f32_var(vm, buf, "Precipitation").map(|v| v.clamp(0.0, 1.0)),
            humidity_pct: f32_var(vm, buf, "RelHumidity").map(|v| v.clamp(0.0, 1.0)),
            spectated_car_idx: u32_var(vm, buf, "CamCarIdxTarget"),
            messages: self.messages.clone(),
            chat_messages: Vec::new(), // no broadcast chat source wired
            // Bundled official centerline + corner labels for this track, if any.
            track_path: self.session_min.track_id.and_then(track_map::path_for),
            track_turns: self.session_min.track_id.and_then(track_map::turns_for),
            track_metadata: self.session_min.track_id.and_then(track_map::metadata_for),
        };

        Some(TelemetrySnapshot {
            meta: Meta {
                sim: SimId::IRacing,
                tick: 0,                // stamped by the reader
                frame_timestamp_s: 0.0, // stamped by the reader
                sim_tick: Some(sim_tick),
                changed: ChangeFlags {
                    fast: true,
                    slow: session_changed,
                },
            },
            session,
            player,
            cars,
        })
    }
}
