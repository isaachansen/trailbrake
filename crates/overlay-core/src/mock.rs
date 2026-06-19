//! A synthetic telemetry source.
//!
//! Produces a believable hot lap — pedals trading off through corners, rpm and
//! gear tracking speed, steering swinging, lap distance ramping, lap times and a
//! wandering delta — so the whole pipeline and (later) the widgets run anywhere,
//! including macOS where iRacing can't. This is dev-ergonomics item #1 in §8.

use std::time::{Duration, Instant};

use crate::connector::{Capabilities, ConnectError, SimConnector};
use crate::snapshot::{
    CarState, ChangeFlags, ChatMessage, Meta, PlayerState, RaceControlMessage, Sectors,
    SessionState, SimId, TelemetrySnapshot, TirePressures, TrackTurn,
};

const TAU: f32 = std::f32::consts::TAU;

const PLAYER_IDX: u32 = 4;

const GTP: u32 = 0x20d6b0;
const GT3: u32 = 0x3d8bff;
const GT4: u32 = 0xb06bff;

/// Track centerline (normalized `0..1`, y down), a closed loop with index 0 on
/// the start/finish line — same shape the iRacing connector emits. This is the
/// real Watkins Glen International outline (iRacing track id 433), downsampled
/// from the bundled track map so the mock/browser preview shows a real circuit.
const TRACK_PATH: &[[f32; 2]] = &[
    [0.2412, 0.7575], [0.2153, 0.7575], [0.1897, 0.7575], [0.1633, 0.7576],
    [0.1375, 0.7577], [0.1116, 0.7577], [0.0856, 0.7578], [0.0597, 0.7579],
    [0.0337, 0.7576], [0.0102, 0.7479], [0.0003, 0.7246], [0.0017, 0.6987],
    [0.0049, 0.673], [0.0081, 0.6471], [0.0113, 0.6214], [0.0144, 0.5958],
    [0.0175, 0.57], [0.0232, 0.5447], [0.0346, 0.5215], [0.0513, 0.5018],
    [0.0724, 0.4867], [0.0964, 0.4769], [0.1218, 0.4718], [0.1473, 0.467],
    [0.1715, 0.4579], [0.1938, 0.4446], [0.213, 0.4273], [0.2297, 0.4073],
    [0.2454, 0.3869], [0.2621, 0.3668], [0.2806, 0.3489], [0.3015, 0.3333],
    [0.3239, 0.3202], [0.3473, 0.3092], [0.372, 0.3014], [0.3975, 0.2965],
    [0.4231, 0.2932], [0.4488, 0.2903], [0.4749, 0.2876], [0.5008, 0.2849],
    [0.5264, 0.2823], [0.5524, 0.2797], [0.5779, 0.2771], [0.604, 0.2745],
    [0.6297, 0.2719], [0.6554, 0.2693], [0.6813, 0.2667], [0.7071, 0.2641],
    [0.7329, 0.2614], [0.7587, 0.2602], [0.776, 0.2782], [0.8018, 0.2768],
    [0.8258, 0.2689], [0.8435, 0.2507], [0.8689, 0.2459], [0.8947, 0.2434],
    [0.9205, 0.2423], [0.9459, 0.2477], [0.9688, 0.2596], [0.9869, 0.278],
    [0.9974, 0.3016], [0.9999, 0.3274], [0.9951, 0.3528], [0.9833, 0.3756],
    [0.964, 0.3931], [0.9402, 0.4031], [0.9158, 0.4113], [0.8911, 0.4192],
    [0.8662, 0.427], [0.8414, 0.4345], [0.8165, 0.442], [0.7915, 0.4495],
    [0.7668, 0.4568], [0.7419, 0.4642], [0.717, 0.4717], [0.6922, 0.4792],
    [0.6673, 0.4867], [0.6426, 0.4942], [0.6176, 0.5019], [0.5931, 0.5095],
    [0.5681, 0.5173], [0.5438, 0.526], [0.5243, 0.5427], [0.5155, 0.5669],
    [0.5157, 0.5927], [0.5161, 0.6186], [0.5163, 0.6446], [0.5163, 0.6706],
    [0.5161, 0.6965], [0.5122, 0.722], [0.4975, 0.743], [0.4745, 0.7546],
    [0.4489, 0.7579], [0.4227, 0.7578], [0.397, 0.7576], [0.371, 0.7575],
    [0.3453, 0.7575], [0.3189, 0.7574], [0.2934, 0.7574], [0.2673, 0.7574],
];

/// Corner labels for the mock track (Watkins Glen International), in the same
/// normalized space as `TRACK_PATH`. `(label, x, y)`.
const TRACK_TURNS: &[(&str, f32, f32)] = &[
    ("1", -0.00523, 0.76574),
    ("2", 0.06541, 0.52983),
    ("3", 0.17027, 0.4451),
    ("4", 0.16718, 0.40109),
    ("5", 0.31577, 0.36065),
    ("6", 0.70924, 0.24639),
    ("7", 1.00829, 0.28764),
    ("8", 0.96174, 0.30897),
    ("9", 0.5362, 0.55933),
    ("10", 0.47234, 0.72853),
];

struct MockCar {
    idx: u32,
    name: &'static str,
    number: &'static str,
    country: &'static str,
    class_id: u32,
    class_name: &'static str,
    color: u32,
    license: &'static str,
    irating: i32,
    irating_delta: i32,
    positions_gained: i32,
    tyre: &'static str,
    best: f32,
    base_pos: u32,
    base_gap: f32,
}

const FIELD: &[MockCar] = &[
    MockCar {
        idx: 0,
        name: "M. Rossi",
        number: "92",
        country: "FR",
        class_id: 1,
        class_name: "GTP",
        color: GTP,
        license: "P 4.8",
        irating: 8200,
        irating_delta: 12,
        positions_gained: 1,
        tyre: "S",
        best: 105.5,
        base_pos: 1,
        base_gap: 6.2,
    },
    MockCar {
        idx: 1,
        name: "K. Tanaka",
        number: "6",
        country: "JP",
        class_id: 1,
        class_name: "GTP",
        color: GTP,
        license: "A 3.9",
        irating: 6500,
        irating_delta: -8,
        positions_gained: -1,
        tyre: "M",
        best: 105.8,
        base_pos: 2,
        base_gap: 3.9,
    },
    MockCar {
        idx: 2,
        name: "L. Becker",
        number: "51",
        country: "DE",
        class_id: 1,
        class_name: "GTP",
        color: GTP,
        license: "P 4.2",
        irating: 7800,
        irating_delta: 5,
        positions_gained: 0,
        tyre: "M",
        best: 106.0,
        base_pos: 3,
        base_gap: 2.1,
    },
    MockCar {
        idx: 3,
        name: "S. Dubois",
        number: "71",
        country: "GB",
        class_id: 2,
        class_name: "GT3",
        color: GT3,
        license: "B 3.8",
        irating: 6100,
        irating_delta: 9,
        positions_gained: 2,
        tyre: "S",
        best: 106.4,
        base_pos: 4,
        base_gap: 0.9,
    },
    MockCar {
        idx: PLAYER_IDX,
        name: "You",
        number: "4",
        country: "US",
        class_id: 2,
        class_name: "GT3",
        color: GT3,
        license: "A 3.3",
        irating: 3300,
        irating_delta: -3,
        positions_gained: 1,
        tyre: "M",
        best: 106.6,
        base_pos: 5,
        base_gap: 0.0,
    },
    MockCar {
        idx: 5,
        name: "A. Novak",
        number: "44",
        country: "DE",
        class_id: 2,
        class_name: "GT3",
        color: GT3,
        license: "A 4.5",
        irating: 5800,
        irating_delta: 18,
        positions_gained: 3,
        tyre: "H",
        best: 106.5,
        base_pos: 6,
        base_gap: -1.4,
    },
    MockCar {
        idx: 6,
        name: "T. Olsen",
        number: "7",
        country: "SE",
        class_id: 2,
        class_name: "GT3",
        color: GT3,
        license: "C 1.8",
        irating: 2400,
        irating_delta: -10,
        positions_gained: -2,
        tyre: "H",
        best: 106.1,
        base_pos: 7,
        base_gap: -3.8,
    },
    MockCar {
        idx: 7,
        name: "M. Cairo",
        number: "22",
        country: "ES",
        class_id: 2,
        class_name: "GT3",
        color: GT3,
        license: "C 2.4",
        irating: 2800,
        irating_delta: 32,
        positions_gained: 4,
        tyre: "M",
        best: 105.9,
        base_pos: 8,
        base_gap: -5.6,
    },
    MockCar {
        idx: 8,
        name: "R. Mehta",
        number: "9",
        country: "GB",
        class_id: 2,
        class_name: "GT3",
        color: GT3,
        license: "B 2.7",
        irating: 3200,
        irating_delta: 6,
        positions_gained: 0,
        tyre: "M",
        best: 107.0,
        base_pos: 9,
        base_gap: -7.9,
    },
    MockCar {
        idx: 9,
        name: "G. Fontana",
        number: "36",
        country: "IT",
        class_id: 3,
        class_name: "GT4",
        color: GT4,
        license: "B 3.4",
        irating: 3100,
        irating_delta: 15,
        positions_gained: 2,
        tyre: "M",
        best: 110.4,
        base_pos: 10,
        base_gap: -9.1,
    },
    MockCar {
        idx: 10,
        name: "H. Park",
        number: "10",
        country: "JP",
        class_id: 3,
        class_name: "GT4",
        color: GT4,
        license: "C 2.1",
        irating: 2200,
        irating_delta: 8,
        positions_gained: 1,
        tyre: "H",
        best: 110.5,
        base_pos: 11,
        base_gap: -12.7,
    },
    MockCar {
        idx: 11,
        name: "B. Costa",
        number: "59",
        country: "BR",
        class_id: 3,
        class_name: "GT4",
        color: GT4,
        license: "D 3.6",
        irating: 1500,
        irating_delta: 42,
        positions_gained: 5,
        tyre: "W",
        best: 111.0,
        base_pos: 12,
        base_gap: -15.3,
    },
    MockCar {
        idx: 12,
        name: "J. Webb",
        number: "88",
        country: "US",
        class_id: 2,
        class_name: "GT3",
        color: GT3,
        license: "R 1.49",
        irating: 850,
        irating_delta: 61,
        positions_gained: -1,
        tyre: "M",
        best: 108.2,
        base_pos: 13,
        base_gap: -18.5,
    },
];

fn class_position(class_id: u32, base_pos: u32) -> u32 {
    FIELD
        .iter()
        .filter(|c| c.class_id == class_id && c.base_pos <= base_pos)
        .count() as u32
}

/// Target output rate. The mock paces itself to roughly this (iRacing's physics
/// rate) so consumers see a realistic cadence.
const TARGET_HZ: f64 = 60.0;

/// Length of the synthetic lap, seconds.
const LAP_SECONDS: f32 = 90.0;

pub struct MockConnector {
    connected: bool,
    /// Wall-clock start, used to drive the synthetic lap deterministically.
    started: Instant,
    /// Last time we emitted a frame (for pacing to ~60 Hz).
    last_emit: Instant,
    /// Lap counter, incremented as `lap_dist_pct` wraps.
    lap: i32,
    /// Best lap so far (seconds); `None` until the first lap completes.
    best_lap_s: Option<f32>,
    /// `lap_dist_pct` from the previous frame, to detect wrap-around.
    prev_pct: f32,
}

impl Default for MockConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl MockConnector {
    pub fn new() -> Self {
        let now = Instant::now();
        Self {
            connected: false,
            started: now,
            last_emit: now,
            lap: 0,
            best_lap_s: None,
            prev_pct: 0.0,
        }
    }

    /// Build the snapshot for elapsed time `t` (seconds since start).
    fn frame(&mut self, t: f32) -> TelemetrySnapshot {
        // Fraction around the current lap.
        let pct = (t % LAP_SECONDS) / LAP_SECONDS;

        // Detect a lap wrap (pct jumped from ~1 back toward 0).
        let mut changed_slow = false;
        if pct < self.prev_pct {
            self.lap += 1;
            // Vary the "completed" lap time a touch so best-lap updates.
            let lap_time = LAP_SECONDS + (self.lap as f32 * 0.137).sin() * 0.8;
            self.best_lap_s = Some(match self.best_lap_s {
                Some(b) => b.min(lap_time),
                None => lap_time,
            });
            changed_slow = true;
        }
        self.prev_pct = pct;

        // A few "corners" per lap: throttle and brake trade off around a sine.
        let corner_phase = (pct * TAU * 5.0).sin(); // 5 corners
        let throttle = (0.5 + 0.5 * corner_phase).clamp(0.0, 1.0);
        let brake = ((-corner_phase - 0.3).max(0.0)).clamp(0.0, 1.0);

        // Speed loosely follows throttle; 30..75 m/s (~108..270 km/h).
        let speed = 30.0 + 45.0 * throttle;

        // Gear from speed; rough thresholds.
        let gear = match speed {
            s if s < 35.0 => 2,
            s if s < 45.0 => 3,
            s if s < 55.0 => 4,
            s if s < 65.0 => 5,
            _ => 6,
        };

        // RPM: a sawtooth within the gear, riding throttle.
        let rpm = 4000.0 + 4500.0 * (0.3 + 0.7 * throttle) * (0.6 + 0.4 * corner_phase.abs());

        // Steering: swings with the corners, in radians (positive = left).
        let steering = 0.6 * (pct * TAU * 5.0 + 0.4).sin();

        // Fuel burns down across the run.
        let fuel = (60.0 - t * 0.02).max(0.0);

        // A wandering delta to best, +/- ~0.4 s.
        let delta_best = 0.4 * (t * 0.7).sin();

        TelemetrySnapshot {
            meta: Meta {
                sim: SimId::Mock,
                // tick / timestamp are stamped by the reader.
                tick: 0,
                frame_timestamp_s: 0.0,
                sim_tick: Some((t * TARGET_HZ as f32) as i64),
                changed: ChangeFlags {
                    fast: true,
                    slow: changed_slow,
                },
            },
            session: SessionState {
                track_name: Some("Watkins Glen International".to_string()),
                track_turns: Some(
                    TRACK_TURNS
                        .iter()
                        .map(|&(label, x, y)| TrackTurn { label: label.to_string(), x, y })
                        .collect(),
                ),
                session_type: Some("Practice".to_string()),
                time_remaining_s: Some((1800.0 - t as f64).max(0.0)),
                laps_remaining: None,
                total_cars: Some(1),
                flags_raw: Some(0),
                air_temp_c: Some(22.0),
                track_temp_c: Some(31.0),
                wind_speed_ms: Some(3.5),
                wind_dir_rad: Some(1.2),
                track_wetness_pct: Some(0.0),
                precipitation_pct: Some(0.0),
                humidity_pct: Some(0.55),
                spectated_car_idx: Some(PLAYER_IDX),
                messages: vec![RaceControlMessage {
                    time_s: Some(t as f64 - 30.0),
                    kind: "info".to_string(),
                    text: "Fastest lap #92 — 1:45.51".to_string(),
                    priority: 5,
                }],
                chat_messages: vec![
                    ChatMessage {
                        user: "apex_andy".to_string(),
                        color: Some("#2fe08a".to_string()),
                        badge: None,
                        text: "that overtake into 7 was clean".to_string(),
                        time_s: Some(t as f64 - 12.0),
                    },
                    ChatMessage {
                        user: "turn1_tina".to_string(),
                        color: Some("#37d4ea".to_string()),
                        badge: Some("MOD".to_string()),
                        text: "fuel's gonna be tight".to_string(),
                        time_s: Some(t as f64 - 8.0),
                    },
                    ChatMessage {
                        user: "slipstream_sam".to_string(),
                        color: Some("#ffb43d".to_string()),
                        badge: None,
                        text: "P2 incoming let's go".to_string(),
                        time_s: Some(t as f64 - 4.0),
                    },
                ],
                track_path: Some(TRACK_PATH.to_vec()),
            },
            player: PlayerState {
                speed_ms: Some(speed),
                rpm: Some(rpm),
                gear: Some(gear),
                throttle: Some(throttle),
                brake: Some(brake),
                clutch: Some(0.0),
                steering_rad: Some(steering),
                lap_dist_pct: Some(pct),
                fuel_l: Some(fuel),
                fuel_per_lap_l: Some(2.4),
                lap: Some(self.lap),
                current_lap_s: Some(t % LAP_SECONDS),
                last_lap_s: self.best_lap_s,
                best_lap_s: self.best_lap_s,
                delta_best_s: Some(delta_best),
                delta_session_best_s: Some(delta_best + 0.1),
                position: Some(5),
                class_position: Some(class_position(1, 5)),
                car_idx: Some(PLAYER_IDX),
                car_name: Some("Mock GT3".to_string()),
                on_track: Some(true),
                in_garage: Some(false),
                // Tie the spotter to the two weaving "near" cars (idx 3 right, 5 left)
                // so the screen-edge glow lights on the side a car draws alongside,
                // matching the Radar/Spotter widgets (which read relLatM sign).
                car_left: Some((12.0 * (t * 0.5 + 5.0).sin()).abs() < 3.0),
                car_right: Some((12.0 * (t * 0.5 + 3.0).sin()).abs() < 3.0),
                pit_speed_limit_ms: Some(22.35), // ~80 km/h
                pit_box_dist_m: None,
                sector_times_s: Sectors {
                    s1: Some(t % LAP_SECONDS * 0.33),
                    s2: if pct > 0.33 { Some(t % LAP_SECONDS * 0.33) } else { None },
                    s3: if pct > 0.66 { Some(t % LAP_SECONDS * 0.34) } else { None },
                },
                sector_best_s: Sectors {
                    s1: Some(LAP_SECONDS * 0.33),
                    s2: Some(LAP_SECONDS * 0.33),
                    s3: Some(LAP_SECONDS * 0.34),
                },
                brake_bias_pct: Some(0.56),
                abs_active: Some(brake > 0.8),
                tc_active: Some(false),
                drs_state: None,
                ers_pct: None,
                fuel_mix: None,
                p2p_available: None,
                tire_pressures: TirePressures {
                    lf_kpa: Some(127.0),
                    rf_kpa: Some(129.0),
                    lr_kpa: Some(122.0),
                    rr_kpa: Some(124.0),
                },
            },
            cars: self.build_field(t),
        }
    }

    /// Build a small multiclass field with gently animated gaps so the
    /// Relative/Standings widgets have believable data.
    fn build_field(&self, t: f32) -> Vec<CarState> {
        FIELD
            .iter()
            .map(|c| {
                let wobble = 0.6 * (t * 0.3 + c.idx as f32).sin();
                let gap = if c.idx == PLAYER_IDX {
                    0.0
                } else {
                    c.base_gap + wobble
                };

                // Radar: the two nearest cars weave past in the left/right lanes;
                // everyone else sits off-radar at a coarse gap-derived distance.
                let (rel_lat_m, rel_lon_m) = if c.idx == PLAYER_IDX {
                    (None, None)
                } else if c.idx == 3 || c.idx == 5 {
                    (
                        Some(if c.idx == 3 { 2.1 } else { -2.1 }),
                        Some(12.0 * (t * 0.5 + c.idx as f32).sin()),
                    )
                } else {
                    (Some(0.0), Some((gap * 42.0).clamp(-240.0, 240.0)))
                };

                CarState {
                    car_idx: c.idx,
                    driver_name: Some(c.name.to_string()),
                    car_screen_name: Some(format!("{} Car", c.class_name)),
                    car_class_id: Some(c.class_id),
                    car_class_name: Some(c.class_name.to_string()),
                    class_color: Some(c.color),
                    car_number: Some(c.number.to_string()),
                    country: Some(c.country.to_string()),
                    positions_gained: Some(c.positions_gained),
                    irating_delta: Some(c.irating_delta),
                    tyre: Some(c.tyre.to_string()),
                    position: Some(c.base_pos),
                    class_position: Some(class_position(c.class_id, c.base_pos)),
                    lap: Some(self.lap),
                    lap_dist_pct: Some(((t / LAP_SECONDS) + gap / LAP_SECONDS).rem_euclid(1.0)),
                    gap_to_player_s: Some(gap),
                    last_lap_s: Some(c.best + 0.4 + 0.6 * (t * 0.2 + c.idx as f32).sin().abs()),
                    best_lap_s: Some(c.best),
                    on_pit_road: Some(false),
                    irating: Some(c.irating),
                    safety_rating: Some(c.license.to_string()),
                    rel_lat_m,
                    rel_lon_m,
                    pit_status: Some(0),
                    has_session_fastest: Some(c.idx == 0),
                }
            })
            .collect()
    }
}

impl SimConnector for MockConnector {
    fn sim_id(&self) -> SimId {
        SimId::Mock
    }

    fn connect(&mut self) -> Result<(), ConnectError> {
        self.connected = true;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            clutch: true,
            steering_angle: true,
            fuel: true,
            deltas: true,
            relative_gaps: true,
            irating: true,
            safety_rating: true, // mock provides LicString for every car
            multiclass: true,
            proximity: true,
            track_map: true,
            race_control: true,
            chat: true,
            weather: true,
            sectors: true,
            car_setup: true,
            spectator: true,
            pit_info: true,
        }
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        // Pace to ~TARGET_HZ without busy-spinning: sleep out the remainder of
        // the frame budget. Mirrors how the iRacing connector blocks on the
        // data-ready event.
        let frame = Duration::from_secs_f64(1.0 / TARGET_HZ);
        let since = self.last_emit.elapsed();
        if since < frame {
            std::thread::sleep(frame - since);
        }
        self.last_emit = Instant::now();

        let t = self.started.elapsed().as_secs_f32();
        Some(self.frame(t))
    }
}
