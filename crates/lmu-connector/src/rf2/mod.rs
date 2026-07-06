//! Low-level rFactor 2 / Le Mans Ultimate shared-memory primitives.
//!
//! LMU is built on the rFactor 2 engine and publishes telemetry through the
//! community **rF2 Shared Memory Map Plugin** (TheIronWolf's
//! `rF2SharedMemoryMapPlugin` — the same plugin Crew Chief / SimHub read). The
//! plugin must be installed into LMU's `Plugins` folder and enabled; without it
//! there is no shared memory and [`crate::LmuConnector::connect`] reports
//! `NotRunning`.
//!
//! # Layout reference
//!
//! Each named mapping begins with an 8-byte **version block** the plugin bumps
//! around every write, used for torn-frame detection (analogous to iRacing's
//! per-buffer `tickCount`, but there is **no data-ready event** — rF2 is
//! poll-based):
//!
//! ```text
//!   0  u32 mVersionUpdateBegin   bumped BEFORE the buffer is written
//!   4  u32 mVersionUpdateEnd     bumped AFTER  the write completes
//! ```
//!
//! A frame is coherent when `begin == end` and neither changed across our copy.
//! `MappedBuffer<T>` (the plugin's own wrapper, `Include/MappedBuffer.h`) always
//! prepends this 8-byte block ahead of the payload struct `T` — including for
//! `$rFactor2SMMP_Extended$`, which has no `mBytesUpdatedHint` of its own.
//!
//! After the version block, the `Telemetry`/`Scoring` buffer bodies (from the
//! plugin's `rF2State.h`) begin with `int mBytesUpdatedHint`, then the payload.
//! Byte offsets below are **region-absolute** (measured from the start of the
//! mapping, i.e. they already include the 8-byte version block), MSVC
//! `#[repr(C)]` packing, LE.
//!
//! The rF2 structs are declared under **`#pragma pack(4)`** (confirmed via
//! `#pragma pack(push, 4)` / `pack(pop)` bracketing `rF2State.h`), so `double`s
//! and `ULONGLONG`s sit on 4-byte boundaries with no padding after a preceding
//! 4-byte `long`/`int` — the offsets below account for that (e.g. `mEngineRPM`
//! is at `mGear + 4`, not `mGear + 8`).
//!
//! # Offset provenance
//!
//! Every offset below was computed from the **authoritative struct field
//! order**, fetched directly from the plugin repo (no code copied, only field
//! names/types/order used to compute byte layout):
//! - `TheIronWolfModding/rF2SharedMemoryMapPlugin` — `Include/rF2State.h` (C++,
//!   canonical) and `Monitor/rF2SMMonitor/rF2SMMonitor/rF2Data.cs` (C#
//!   `[StructLayout(Pack = 4)]` mirror — authoritative for the LMU-era hybrid
//!   fields `mBatteryChargeFraction` / `mPhysicalSteeringWheelRange` /
//!   `mElectricBoost*`, which are present in both and field-for-field identical).
//!
//! Offsets are marked:
//! - ✅ **CALIBRATED** — verified against a live LMU session (Silverstone, WEC):
//!   the orientation block reads as an orthonormal rotation matrix, gear/rpm/
//!   pedals read physically coherent values.
//! - 🧪 **NEEDS LIVE CALIBRATION** — correct-by-construction (computed from the
//!   authoritative field order under pack(4)), but not yet cross-checked against
//!   real bytes. Run `overlay-cli --source lmu` with `OVERLAY_DUMP_RF2=1` during
//!   a live LMU session to confirm/re-derive — the dump prints both a raw field
//!   scan and, for the new fields, the specific computed value (e.g. "fuel_l ="),
//!   so a mismatch (implausible RPM-sized number where fuel should be, etc.) is
//!   easy to spot and the fix is a one-file offset edit here.
//!
//! Two additional assumptions, called out because they shift *every* offset
//! after them if wrong (re-verify these first if the scoring-buffer dump looks
//! wrong):
//! - `rF2ScoringInfo::pointer1` / `::pointer2` are `unsigned char[8]` (the
//!   `_AMD64_` branch in `rF2State.h`) — LMU only ships a 64-bit binary, so the
//!   plugin loaded into it must be a 64-bit build too. If a future 32-bit LMU
//!   build ever existed, these would be `[4]` and every scoring-vehicle offset
//!   below would shift by −8.
//! - `bool` is 1 byte (standard MSVC `sizeof(bool) == 1`), and `ULONGLONG`
//!   (used only in the Extended buffer) is 8 bytes aligned to 4 under pack(4).

pub mod decode;
#[cfg(windows)]
pub mod mmap;

/// Named mapping for the ~50–90 Hz physics buffer (the FAST path).
///
/// Unqualified name ⇒ resolved in the caller's session namespace (`Local\`),
/// which is where the plugin creates it; LMU and the overlay share a session.
pub const TELEMETRY_MAP: &str = "$rFactor2SMMP_Telemetry$";

/// Named mapping for the ~5 Hz session/standings buffer (the SLOW path).
pub const SCORING_MAP: &str = "$rFactor2SMMP_Scoring$";

/// Named mapping for the low-frequency "everything else" buffer: physics
/// options, damage tracking, status messages, and (what we want)
/// `mCurrentPitSpeedLimit`. Best-effort: `pit_info` capability is only `true`
/// when this mapping is present *and* the read looks sane (see
/// [`ext::CURRENT_PIT_SPEED_LIMIT`]).
pub const EXTENDED_MAP: &str = "$rFactor2SMMP_Extended$";

/// Bytes of the version block prefixing every mapping.
pub const VERSION_BLOCK_LEN: usize = 8;
/// Offset of `mVersionUpdateBegin` (u32).
pub const VERSION_BEGIN: usize = 0;
/// Offset of `mVersionUpdateEnd` (u32).
pub const VERSION_END: usize = 4;

/// Region-absolute offsets into `$rFactor2SMMP_Telemetry$`.
///
/// `rF2Telemetry { int mBytesUpdatedHint; int mNumVehicles;
/// rF2VehicleTelemetry mVehicles[128]; }` laid out after the version block.
pub mod tele {
    use super::VERSION_BLOCK_LEN;

    /// `int mNumVehicles` — count of populated telemetry slots.
    pub const NUM_VEHICLES: usize = VERSION_BLOCK_LEN + 4;
    /// First `rF2VehicleTelemetry` (`mVehicles[0]`).
    pub const VEHICLES: usize = VERSION_BLOCK_LEN + 8;

    /// `sizeof(rF2VehicleTelemetry)` under pack(4): computed field-by-field from
    /// the full struct (ending in `mExpansion[111]` then `mWheels[4]`) — see
    /// `veh::WHEELS` below for the derivation. 🧪 NEEDS LIVE CALIBRATION (the
    /// fields *before* `mWheels` are ✅ calibrated; the stride itself — i.e.
    /// that vehicle N+1 truly starts exactly here — is only exercised once we
    /// read a second vehicle, which needs a live multi-car session).
    pub const STRIDE: usize = 1888;

    /// Region-absolute offset of telemetry vehicle slot `i`'s
    /// `rF2VehicleTelemetry`. Bounds are enforced by the bounds-checked readers
    /// in [`super::decode`], not here.
    pub const fn offset(i: usize) -> usize {
        VEHICLES + i * STRIDE
    }

    /// Field offsets **within** one `rF2VehicleTelemetry` (`#pragma pack(4)`, so
    /// `double`s follow a 4-byte `long` with no padding).
    pub mod veh {
        pub const ID: usize = 0; // long mID                          ✅ CALIBRATED
        pub const ELAPSED_TIME: usize = 12; // double mElapsedTime    🧪
        /// `double mLapStartET` — time this lap was started (game session
        /// clock). Combined with `ELAPSED_TIME`, derives `current_lap_s`
        /// (rF2 exposes no live current-lap-time field directly).
        pub const LAP_START_ET: usize = 24; // 🧪
        pub const LAP_NUMBER: usize = 20; // long mLapNumber          ✅ CALIBRATED
        pub const LOCAL_VEL: usize = 184; // rF2Vec3 mLocalVel (m/s, car frame) ✅ CALIBRATED
        pub const GEAR: usize = 352; // long mGear (-1 rev, 0 N, 1.. fwd)       ✅ CALIBRATED
        pub const ENGINE_RPM: usize = 356; // double mEngineRPM (rev/min)      ✅ CALIBRATED
        pub const FILTERED_THROTTLE: usize = 420; // double (0..1)   ✅ CALIBRATED
        pub const FILTERED_BRAKE: usize = 428; // double (0..1)      ✅ CALIBRATED
        pub const FILTERED_STEERING: usize = 436; // double (-1..1 normalized) ✅ CALIBRATED
        pub const FILTERED_CLUTCH: usize = 444; // double (0..1)     ✅ CALIBRATED

        /// `double mFuel` — liters. 🧪 NEEDS LIVE CALIBRATION.
        pub const FUEL: usize = 524;
        /// `double mRearBrakeBias` — fraction of brakes on the REAR (note: the
        /// inverse of our `brake_bias_pct`, which is documented as *front*
        /// fraction — see `connector.rs`). 🧪 NEEDS LIVE CALIBRATION.
        pub const REAR_BRAKE_BIAS: usize = 664;
        /// `float mPhysicalSteeringWheelRange` — degrees, lock-to-lock range of
        /// the *physical* wheel (as opposed to `mVisualSteeringWheelRange`).
        /// Note this is an `f32`, not `f64` (rF2 mixes float/double). 🧪
        pub const PHYSICAL_STEERING_WHEEL_RANGE: usize = 692;
        /// `double mBatteryChargeFraction` — hybrid battery charge `0.0..1.0`.
        /// Present in the LMU-era C# mirror; version-gated in practice (older
        /// non-hybrid classes will simply read `0.0`, which we cannot
        /// distinguish from "no battery" — left as a known limitation). 🧪
        pub const BATTERY_CHARGE_FRACTION: usize = 696;

        /// First `rF2Wheel` (`mWheels[0]`), the last field of
        /// `rF2VehicleTelemetry` (front-left, front-right, rear-left,
        /// rear-right). 🧪 NEEDS LIVE CALIBRATION.
        pub const WHEELS: usize = 848;

        /// Field offsets **within** one `rF2Wheel` (`#pragma pack(4)`).
        pub mod wheel {
            /// `sizeof(rF2Wheel)` under pack(4). 🧪
            pub const STRIDE: usize = 260;
            /// `double mPressure` — kPa (tire pressure). 🧪 NEEDS LIVE CALIBRATION.
            pub const PRESSURE: usize = 120;

            /// Region-absolute offset of wheel `w` (0=LF,1=RF,2=LR,3=RR)'s
            /// field `field_off` (e.g. [`PRESSURE`]), given the vehicle's base
            /// offset `veh_base` (from [`super::super::offset`]).
            pub const fn offset(veh_base: usize, w: usize, field_off: usize) -> usize {
                veh_base + super::WHEELS + w * STRIDE + field_off
            }
        }
    }
}

/// Region-absolute offsets into `$rFactor2SMMP_Scoring$`.
///
/// `rF2Scoring { int mBytesUpdatedHint; rF2ScoringInfo mScoringInfo;
/// rF2VehicleScoring mVehicles[128]; }`.
pub mod scor {
    use super::VERSION_BLOCK_LEN;

    /// `rF2ScoringInfo mScoringInfo` starts right after `int mBytesUpdatedHint`.
    pub const SCORING_INFO: usize = VERSION_BLOCK_LEN + 4;

    /// `sizeof(rF2ScoringInfo)` under pack(4), assuming 8-byte `pointer1`/
    /// `pointer2` (`_AMD64_`; see module-level doc). 🧪 NEEDS LIVE CALIBRATION
    /// (shifts every scoring-vehicle offset if the pointer-size assumption is
    /// wrong — verify `mNumVehicles`/`mGamePhase` in the dump first).
    pub const INFO_LEN: usize = 548;

    /// First `rF2VehicleScoring` (`mVehicles[0]`), right after `mScoringInfo`.
    pub const VEHICLES: usize = SCORING_INFO + INFO_LEN;

    /// `sizeof(rF2VehicleScoring)` under pack(4). Self-contained (does not
    /// depend on the `INFO_LEN` pointer-size assumption above). 🧪
    pub const VEH_STRIDE: usize = 584;

    /// Region-absolute offset of scoring vehicle slot `i`'s `rF2VehicleScoring`.
    pub const fn veh_offset(i: usize) -> usize {
        VEHICLES + i * VEH_STRIDE
    }

    /// Field offsets **within** `rF2ScoringInfo` (`#pragma pack(4)`). `mTrackName`
    /// and `mSession` are verified against a live session; the timing fields
    /// follow the documented pack(4) layout. The car count comes from the
    /// telemetry buffer's `mNumVehicles` instead (rock-solid), so it's not read
    /// here for that purpose (though `NUM_VEHICLES` is still centralized below
    /// for the calibration dump / cross-check).
    pub mod info {
        pub const TRACK_NAME: usize = 0; // char mTrackName[64]           ✅ CALIBRATED
        pub const TRACK_NAME_LEN: usize = 64;
        pub const SESSION: usize = 64; // long mSession (see session_label) ✅ CALIBRATED
        pub const CURRENT_ET: usize = 68; // double mCurrentET (s)        ✅ CALIBRATED
        pub const END_ET: usize = 76; // double mEndET (s; 0 = none)      ✅ CALIBRATED
        pub const MAX_LAPS: usize = 84; // long mMaxLaps                  ✅ CALIBRATED
        /// `double mLapDist` — TRACK LENGTH in meters (distinct from the
        /// per-vehicle `mLapDist`, which is *distance so far this lap*).
        /// `lap_dist_pct = vehicle.mLapDist / this`. 🧪
        pub const LAP_DIST: usize = 88;
        // `pointer1[8]` (assumed AMD64) sits at 96..104.
        /// `long mNumVehicles` — cross-check only; `tele::NUM_VEHICLES` is the
        /// value actually used (verified). 🧪
        pub const NUM_VEHICLES: usize = 104;
        /// `unsigned char mGamePhase` — see [`super::super::flags`] mapping. 🧪
        pub const GAME_PHASE: usize = 108;
        /// `signed char mYellowFlagState`. 🧪
        pub const YELLOW_FLAG_STATE: usize = 109;
        /// `signed char mSectorFlag[3]` — per-sector local-yellow indicator. 🧪
        pub const SECTOR_FLAG: usize = 110;
        pub const SECTOR_FLAG_LEN: usize = 3;
        /// `double mRaining` — severity `0.0..1.0` → `precipitation_pct`. 🧪
        pub const RAINING: usize = 220;
        /// `double mAmbientTemp` — °C → `air_temp_c`. 🧪
        pub const AMBIENT_TEMP: usize = 228;
        /// `double mTrackTemp` — °C → `track_temp_c`. 🧪
        pub const TRACK_TEMP: usize = 236;
        /// `rF2Vec3 mWind` — m/s, world frame → `wind_speed_ms`/`wind_dir_rad`. 🧪
        pub const WIND: usize = 244;
        /// `double mMaxPathWetness` — `0.0..1.0` → `track_wetness_pct`. 🧪
        pub const MAX_PATH_WETNESS: usize = 276;
    }

    /// Field offsets **within** one `rF2VehicleScoring` (`#pragma pack(4)`).
    /// All 🧪 NEEDS LIVE CALIBRATION (none of the per-car scoring fields have
    /// been decoded/verified before this stage).
    pub mod veh {
        pub const ID: usize = 0; // long mID
        pub const DRIVER_NAME: usize = 4; // char[32]
        pub const DRIVER_NAME_LEN: usize = 32;
        pub const VEHICLE_NAME: usize = 36; // char[64]
        pub const VEHICLE_NAME_LEN: usize = 64;
        pub const TOTAL_LAPS: usize = 100; // short mTotalLaps
        pub const SECTOR: usize = 102; // signed char (0=s3,1=s1,2=s2)
        pub const FINISH_STATUS: usize = 103; // signed char
        /// `double mLapDist` — distance so far THIS lap (meters); divide by
        /// `info::LAP_DIST` (track length) for `lap_dist_pct`.
        pub const LAP_DIST: usize = 104;
        pub const BEST_SECTOR1: usize = 128; // double — aggregate best S1 (not necessarily same lap as best S2)
        pub const BEST_SECTOR2: usize = 136; // double — aggregate best S1+S2
        pub const BEST_LAP_TIME: usize = 144; // double
        pub const LAST_SECTOR1: usize = 152; // double — cumulative (S1 only)
        pub const LAST_SECTOR2: usize = 160; // double — cumulative (S1+S2)
        pub const LAST_LAP_TIME: usize = 168; // double
        pub const CUR_SECTOR1: usize = 176; // double — cumulative, this lap in progress
        pub const CUR_SECTOR2: usize = 184; // double — cumulative, this lap in progress
        pub const IS_PLAYER: usize = 196; // bool (1 byte)
        pub const CONTROL: usize = 197; // signed char: -1 nobody,0 player,1 AI,2 remote,3 replay
        pub const IN_PITS: usize = 198; // bool
        pub const PLACE: usize = 199; // unsigned char, 1-based position
        pub const VEHICLE_CLASS: usize = 200; // char[32]
        pub const VEHICLE_CLASS_LEN: usize = 32;
        pub const LAP_START_ET: usize = 256; // double
        /// `rF2Vec3 mPos` — world position (meters). Used (with `ORI`) for the
        /// radar's relative lateral/longitudinal offsets.
        pub const POS: usize = 264;
        /// `rF2Vec3 mOri[3]` — rows of the orientation matrix; row `r` dotted
        /// with a LOCAL vector gives that vector's WORLD component `r`
        /// (documented in the struct comment). To go WORLD → LOCAL (what the
        /// radar needs) we use the transpose (valid since this is a rotation
        /// matrix / orthonormal): `local[j] = Σ_r ori[r][j] * world[r]`.
        pub const ORI: usize = 336;
        pub const PIT_STATE: usize = 457; // unsigned char: 0 none,1 request,2 entering,3 stopped,4 exiting
        /// `bool mInGarageStall` — combined with `CONTROL >= 0` to derive
        /// `in_world` (loaded into the world vs. sitting in the garage).
        pub const IN_GARAGE_STALL: usize = 507;
        /// `double mTimeIntoLap` — estimated time into the vehicle's current
        /// lap; the rF2 analogue of iRacing's `CarIdxEstTime`, used for the
        /// folded relative-gap estimate.
        pub const TIME_INTO_LAP: usize = 464;
        pub const ESTIMATED_LAP_TIME: usize = 472; // double
        pub const FLAG: usize = 504; // unsigned char: 0=green, 6=blue (only two used values)
        pub const PIT_LAP_DIST: usize = 524; // float — location of the pit box in lap-distance terms
        pub const BEST_LAP_SECTOR1: usize = 528; // float — S1 split FROM the best lap specifically
        pub const BEST_LAP_SECTOR2: usize = 532; // float — S1+S2 split FROM the best lap specifically
    }
}

/// Region-absolute offset(s) into `$rFactor2SMMP_Extended$` (best-effort —
/// only `mCurrentPitSpeedLimit` is decoded).
///
/// `rF2Extended` has no `mBytesUpdatedHint` (it derives from the plain
/// `rF2MappedBufferHeader`, not `...WithSize`), so the version block is
/// followed directly by the struct body.
///
/// 🧪 **HEAVILY NEEDS LIVE CALIBRATION**: `mCurrentPitSpeedLimit` sits ~9.7 KB
/// into a struct containing a `rF2PhysicsOptions`, a 512-entry damage-tracking
/// array, a nested 128-vehicle session-transition capture, and several fixed
/// message buffers — every one of those sizes had to be computed correctly for
/// this single offset to land right. The connector treats an implausible read
/// (outside `0.0..100.0` m/s) as "unavailable" rather than trusting it blindly
/// (see `connector.rs`), and `pit_info` only reports `true` when the mapping
/// opened AND a plausible value was read at least once.
pub mod ext {
    use super::VERSION_BLOCK_LEN;

    /// `float mCurrentPitSpeedLimit` — meters/second.
    pub const CURRENT_PIT_SPEED_LIMIT: usize = VERSION_BLOCK_LEN + 9708;
}

/// Map rF2's `mSession` enum to our normalized session-type label.
///
/// rF2: 0 = test day; 1–4 practice; 5–8 qualifying; 9 warmup; 10–13 race.
pub fn session_label(session: i32) -> Option<&'static str> {
    match session {
        0 => Some("Test Day"),
        1..=4 => Some("Practice"),
        5..=8 => Some("Qualify"),
        9 => Some("Warmup"),
        10..=13 => Some("Race"),
        _ => None,
    }
}
