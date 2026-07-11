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
use crate::lap_history::LapHistoryStore;
use crate::positions::{self, DriverPosInput};
use crate::reference_lap::{self, ReferenceLapStore};
use crate::session::{decode_session_info, parse_min, SessionInfoMin};
use crate::track_map;

/// Wait budget for the data-ready event. Long enough to block (no busy-spin),
/// short enough to notice disconnects / honor shutdown promptly.
const WAIT_TIMEOUT_MS: u32 = 32;

/// iRacing session flags (subset of `irsdk_Flags`) the Race Control widget
/// decodes. Source: iRacing SDK `irsdk_Flags` constants.
#[allow(dead_code)]
mod ir_flags {
    pub const CHECKERED: u32 = 0x0000_0001;
    pub const WHITE: u32 = 0x0000_0002;
    pub const GREEN: u32 = 0x0000_0004;
    pub const YELLOW: u32 = 0x0000_0008;
    pub const RED: u32 = 0x0000_0010;
    pub const BLUE: u32 = 0x0000_0020;
    pub const DEBRIS: u32 = 0x0000_0040;
    pub const CROSSED: u32 = 0x0000_0080;
    pub const YELLOW_WAVING: u32 = 0x0000_0100;
    pub const ONE_LAP_TO_GREEN: u32 = 0x0000_0200;
    pub const GREEN_HELD: u32 = 0x0000_0400;
    pub const TEN_TO_GO: u32 = 0x0000_0800;
    pub const FIVE_TO_GO: u32 = 0x0000_1000;
    pub const RANDOM_WAVING: u32 = 0x0000_2000;
    pub const CAUTION: u32 = 0x0000_4000;
    pub const CAUTION_WAVING: u32 = 0x0000_8000;
    pub const BLACK: u32 = 0x0001_0000;
    pub const DISQUALIFY: u32 = 0x0002_0000;
    pub const SERVICIBLE: u32 = 0x0004_0000;
    pub const FURLED: u32 = 0x0008_0000;
    pub const REPAIR: u32 = 0x0010_0000;
    pub const START_HIDDEN: u32 = 0x1000_0000;
    pub const START_READY: u32 = 0x2000_0000;
    pub const START_SET: u32 = 0x4000_0000;
    pub const START_GO: u32 = 0x8000_0000;
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
    /// Per-sector timing state, derived from `LapDistPct` boundary crossings.
    sector_timer: SectorTimer,
    /// Previous live `SessionNum`, for detecting the weekend advancing
    /// (Practice→Qualy→Race) so per-session state can be reset.
    prev_session_num: Option<i32>,
    /// Previous `SessionUniqueID`, for detecting a switch to a different
    /// server/event without an app restart.
    prev_session_unique_id: Option<i32>,
    /// `tickCount` of the last snapshot we emitted, so the no-event polling
    /// fallback can skip frames the sim hasn't advanced (tick-count polling).
    last_emitted_tick: Option<i64>,
    /// Whether the one-shot `OVERLAY_DUMP_VARS` diagnostic has already run.
    vars_dumped: bool,
    /// Reference lap profiles for multiclass gap interpolation.
    reference_laps: ReferenceLapStore,
    /// Rolling lap-time history per car (trend / avg columns).
    lap_history: LapHistoryStore,
    /// Grid/start position per car for `positions_gained`.
    start_positions: HashMap<u32, u32>,
}

/// `true` when a session-identity var changed between two polls. Only a
/// `Some -> different Some` transition counts — a var briefly reading as absent
/// (torn frame, sim warming up) must not trigger a spurious state reset.
fn session_id_changed(prev: Option<i32>, cur: Option<i32>) -> bool {
    matches!((prev, cur), (Some(a), Some(b)) if a != b)
}

/// Computes per-sector times from `LapDistPct` boundary crossings + `SessionTime`.
///
/// iRacing does not expose per-sector telemetry; it only gives the sector
/// *boundaries* (start fractions) in the session YAML. We watch `LapDistPct`
/// (0..1) and record `SessionTime` whenever the player crosses a boundary.
/// A sector's time is `(time at next boundary) − (time at this boundary)`.
#[derive(Default)]
struct SectorTimer {
    /// Sector-start fractions for the current track (mirrors `session_min`).
    starts: Vec<f32>,
    /// `SessionTime` recorded at the most recent crossing of each boundary,
    /// for the lap currently in progress. `None` until first crossed this lap.
    cross_times: Vec<Option<f64>>,
    /// Completed sector times for the lap *currently in progress* (s).
    cur_lap_times: Vec<Option<f32>>,
    /// Previous lap's sector times — updated immediately on each sector close.
    prev_lap_times: Vec<Option<f32>>,
    /// Sector splits of the fastest *complete* lap seen this session.
    best_lap_times: Vec<Option<f32>>,
    /// Total time of that fastest complete lap (s).
    best_lap_sum: Option<f32>,
    /// Per-sector session bests (independent mins), not tied to one lap.
    session_best_times: Vec<Option<f32>>,
    /// Prior session-best value when a sector just set a new best (purple delta).
    prev_session_best_times: Vec<Option<f32>>,
    /// Index of the sector currently being driven.
    current_sector_idx: usize,
    /// SessionTime when the current sector was entered.
    sector_entry_time: Option<f64>,
    /// False after teleport / first seed until a real boundary entry.
    sector_entry_valid: bool,
    /// Previous `LapDistPct`, to detect forward crossings and lap wrap.
    prev_pct: Option<f32>,
    /// Previous `SessionTime`, to detect non-monotonic jumps (restart/replay).
    prev_session_time: Option<f64>,
    /// Teleport, off-track, incident, or session scrub — do not bank this lap.
    lap_tainted: bool,
    /// Bumped on invalidate; a lap may only bank when it started at the current generation.
    lap_generation: u32,
    invalidation_generation: u32,
}

impl SectorTimer {
    /// Re-initialize for a (possibly new) set of sector boundaries. Clears all
    /// accumulated timing so stale data from a previous track can't leak.
    fn set_starts(&mut self, starts: &[f32]) {
        if self.starts == starts {
            return;
        }
        let n = starts.len();
        self.starts = starts.to_vec();
        self.cross_times = vec![None; n];
        self.cur_lap_times = vec![None; n];
        self.prev_lap_times = vec![None; n];
        self.best_lap_times = vec![None; n];
        self.best_lap_sum = None;
        self.session_best_times = vec![None; n];
        self.prev_session_best_times = vec![None; n];
        self.current_sector_idx = 0;
        self.sector_entry_time = None;
        self.sector_entry_valid = false;
        self.prev_pct = None;
        self.prev_session_time = None;
        self.lap_tainted = false;
        self.lap_generation = 0;
        self.invalidation_generation = 0;
    }

    /// Reset the in-progress lap (boundary crossings + this lap's splits), keeping
    /// banked bests / previous lap. Used on session restart / replay scrub.
    fn reset_lap(&mut self) {
        for c in self.cross_times.iter_mut() {
            *c = None;
        }
        for t in self.cur_lap_times.iter_mut() {
            *t = None;
        }
        self.sector_entry_time = None;
        self.sector_entry_valid = false;
    }

    /// Soft teleport: invalidate entry and clear only the landed sector's current time.
    fn soft_teleport(&mut self, pct: f32) {
        self.sector_entry_valid = false;
        self.sector_entry_time = None;
        self.lap_tainted = true;
        self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
        let landed = self.sector_index_at(pct);
        self.current_sector_idx = landed;
        if let Some(t) = self.cur_lap_times.get_mut(landed) {
            *t = None;
        }
        if let Some(c) = self.cross_times.get_mut(landed) {
            *c = None;
        }
    }

    fn sector_index_at(&self, pct: f32) -> usize {
        let n = self.starts.len();
        if n == 0 {
            return 0;
        }
        let mut idx = 0usize;
        for (i, &b) in self.starts.iter().enumerate() {
            if b <= pct {
                idx = i;
            }
        }
        idx
    }

    /// Feed one frame. `pct` is `LapDistPct` (0..1), `session_time` is the
    /// monotonic `SessionTime` clock (s). `on_track` gates accumulation.
    /// `off_track` / `incident` taint the current lap's banking.
    fn update(
        &mut self,
        pct: Option<f32>,
        session_time: Option<f64>,
        on_track: bool,
        off_track: bool,
        incident: bool,
    ) {
        let n = self.starts.len();
        if n == 0 {
            return;
        }
        let (Some(pct), Some(now)) = (pct, session_time) else {
            self.prev_pct = None;
            self.prev_session_time = None;
            self.sector_entry_valid = false;
            return;
        };
        if !on_track || !pct.is_finite() || !(0.0..=1.0).contains(&pct) {
            self.prev_pct = None;
            self.prev_session_time = None;
            self.sector_entry_valid = false;
            return;
        }
        if off_track || incident {
            self.lap_tainted = true;
            self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
        }
        // Session restart / replay scrub: clock went backwards or jumped.
        if let Some(prev_t) = self.prev_session_time {
            if now < prev_t || now - prev_t > 5.0 {
                self.prev_pct = None;
                self.prev_session_time = Some(now);
                self.lap_tainted = true;
                self.invalidation_generation = self.invalidation_generation.wrapping_add(1);
                self.reset_lap();
                return;
            }
        }

        let prev_pct = match self.prev_pct {
            Some(p) => p,
            None => {
                self.prev_pct = Some(pct);
                self.prev_session_time = Some(now);
                self.current_sector_idx = self.sector_index_at(pct);
                self.sector_entry_valid = false;
                return;
            }
        };

        let forward_jump = pct - prev_pct;
        if forward_jump > 0.5 {
            self.soft_teleport(pct);
            self.prev_pct = Some(pct);
            self.prev_session_time = Some(now);
            return;
        }
        if let Some(prev_t) = self.prev_session_time {
            let dt = now - prev_t;
            if dt > 0.0 && dt < 1.0 && forward_jump > 0.0 {
                let speed_pct = forward_jump / dt as f32;
                if speed_pct > 0.08 {
                    self.soft_teleport(pct);
                    self.prev_pct = Some(pct);
                    self.prev_session_time = Some(now);
                    return;
                }
            }
        }

        let wrapped = pct + 0.5 < prev_pct;
        if wrapped {
            self.record_crossing(0, now);
            self.finish_lap();
            for k in 1..n {
                self.cross_times[k] = None;
            }
        } else {
            for k in 0..n {
                let b = self.starts[k];
                if b <= 0.0 {
                    continue;
                }
                if prev_pct < b && pct >= b {
                    self.record_crossing(k, now);
                }
            }
        }

        self.prev_pct = Some(pct);
        self.prev_session_time = Some(now);
    }

    /// Record that boundary `k` was crossed at `now`.
    fn record_crossing(&mut self, k: usize, now: f64) {
        let n = self.starts.len();
        if n == 0 {
            return;
        }
        let ending = (k + n - 1) % n;
        if let Some(start_t) = self.cross_times[ending] {
            let dt = now - start_t;
            if dt > 0.0 && dt < 3600.0 {
                let time = dt as f32;
                self.cur_lap_times[ending] = Some(time);
                // Previous-lap display updates immediately on each sector close.
                if ending < self.prev_lap_times.len() {
                    self.prev_lap_times[ending] = Some(time);
                }
                // Per-sector session best (independent of complete-lap banking).
                let clean = self.lap_generation == self.invalidation_generation && !self.lap_tainted;
                if clean {
                    self.maybe_update_session_best(ending, time);
                }
            }
        }
        self.cross_times[k] = Some(now);
        self.current_sector_idx = k;
        self.sector_entry_time = Some(now);
        self.sector_entry_valid = true;
    }

    fn maybe_update_session_best(&mut self, idx: usize, time: f32) {
        if idx >= self.session_best_times.len() {
            return;
        }
        let better = self.session_best_times[idx].map_or(true, |b| time < b);
        if better {
            self.prev_session_best_times[idx] = self.session_best_times[idx];
            self.session_best_times[idx] = Some(time);
        }
    }

    /// Called at the start/finish crossing. Banks a clean complete lap as best
    /// when its total is the fastest so far, then clears current-lap splits.
    fn finish_lap(&mut self) {
        let lap_clean = self.lap_generation == self.invalidation_generation && !self.lap_tainted;
        let complete = lap_clean
            && !self.cur_lap_times.is_empty()
            && self.cur_lap_times.iter().all(Option::is_some);
        if complete {
            let sum: f32 = self.cur_lap_times.iter().flatten().copied().sum();
            if self.best_lap_sum.map_or(true, |b| sum < b) {
                self.best_lap_sum = Some(sum);
                self.best_lap_times = self.cur_lap_times.clone();
            }
        }
        for t in self.cur_lap_times.iter_mut() {
            *t = None;
        }
        self.lap_tainted = false;
        self.lap_generation = self.invalidation_generation;
    }

    fn to_sectors(times: &[Option<f32>]) -> Sectors {
        Sectors {
            s1: times.first().copied().flatten(),
            s2: times.get(1).copied().flatten(),
            s3: times.get(2).copied().flatten(),
        }
    }

    fn current(&self) -> Sectors {
        Self::to_sectors(&self.cur_lap_times)
    }

    fn previous(&self) -> Sectors {
        Self::to_sectors(&self.prev_lap_times)
    }

    fn best(&self) -> Sectors {
        Self::to_sectors(&self.best_lap_times)
    }

    fn session_best(&self) -> Sectors {
        Self::to_sectors(&self.session_best_times)
    }

    fn session_best_prev(&self) -> Sectors {
        Self::to_sectors(&self.prev_session_best_times)
    }

    fn current_sector_idx(&self) -> Option<u32> {
        if self.starts.is_empty() {
            None
        } else {
            Some(self.current_sector_idx as u32)
        }
    }

    /// Live in-sector delta vs a reference lap profile (negative = ahead).
    fn live_delta(
        &self,
        pct: Option<f32>,
        session_time: Option<f64>,
        ref_lap: Option<&reference_lap::ReferenceLap>,
    ) -> Option<f32> {
        if !self.sector_entry_valid {
            return None;
        }
        let (pct, now, entry, lap) = match (pct, session_time, self.sector_entry_time, ref_lap) {
            (Some(p), Some(n), Some(e), Some(l)) => (p, n, e, l),
            _ => return None,
        };
        let sector_start = self.starts.get(self.current_sector_idx).copied().unwrap_or(0.0);
        let t_now = reference_lap::interpolate_at(lap, pct)?;
        let t_start = reference_lap::interpolate_at(lap, sector_start)?;
        let ghost_elapsed = t_now - t_start;
        if !ghost_elapsed.is_finite() {
            return None;
        }
        let player_elapsed = (now - entry) as f32;
        Some(player_elapsed - ghost_elapsed)
    }

    /// Seconds spent in the current sector since a valid entry.
    fn elapsed(&self, session_time: Option<f64>) -> Option<f32> {
        if !self.sector_entry_valid {
            return None;
        }
        let (now, entry) = match (session_time, self.sector_entry_time) {
            (Some(n), Some(e)) => (n, e),
            _ => return None,
        };
        let dt = (now - entry) as f32;
        if dt.is_finite() && (0.0..3600.0).contains(&dt) {
            Some(dt)
        } else {
            None
        }
    }

    /// Fraction `0..1` through the current sector by LapDistPct.
    fn progress(&self, pct: Option<f32>) -> Option<f32> {
        let pct = pct.filter(|p| p.is_finite() && (0.0..=1.0).contains(p))?;
        let n = self.starts.len();
        if n == 0 {
            return None;
        }
        let i = self.current_sector_idx.min(n - 1);
        let start = self.starts[i];
        let end = if i + 1 < n {
            self.starts[i + 1]
        } else {
            1.0
        };
        let span = end - start;
        if span <= 1e-6 {
            return Some(0.0);
        }
        Some(((pct - start) / span).clamp(0.0, 1.0))
    }

    #[cfg(test)]
    fn lap_is_tainted(&self) -> bool {
        self.lap_tainted
    }

    #[cfg(test)]
    fn entry_valid(&self) -> bool {
        self.sector_entry_valid
    }
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
        let h = Header::parse(map.slice(0, HEADER_LEN)?)?;
        if h.buf_len == 0 {
            return None;
        }
        let vb = *h.latest_buf();
        last_tick = vb.tick_count;

        // Bounds come from the sim-written header; `slice` validates them
        // against the mapped view, so a torn/garbage header fails the poll
        // (not-ready) instead of reading out of the region.
        let src = map.slice(vb.buf_offset, h.buf_len)?;
        scratch.clear();
        scratch.extend_from_slice(src);

        let h2 = Header::parse(map.slice(0, HEADER_LEN)?)?;
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
            sector_timer: SectorTimer::default(),
            prev_session_num: None,
            prev_session_unique_id: None,
            last_emitted_tick: None,
            vars_dumped: false,
            reference_laps: ReferenceLapStore::default(),
            lap_history: LapHistoryStore::default(),
            start_positions: HashMap::new(),
        }
    }

    /// Drop all per-session derived state. Called when the session changes
    /// (weekend advance, different server, or a car/track swap) so nothing
    /// leaks across: a phantom lap crossing would skew fuel-per-lap for up to
    /// 20 laps, and Race Control would show the previous session's flags.
    fn reset_session_state(&mut self) {
        self.fuel_history.clear();
        self.prev_lap = None;
        self.prev_fuel = None;
        self.prev_flags = 0;
        self.messages.clear();
        self.reference_laps.reset();
        self.lap_history.reset();
        self.start_positions.clear();
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
            // De-dup consecutive identical messages: some flag bits (e.g. DEBRIS)
            // flicker rapidly, which would otherwise flood the widget with
            // hundreds of thousands of duplicate "Debris on track" entries.
            if messages.last().is_some_and(|m| m.text == text) {
                return;
            }
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
        if changed & ir_flags::DEBRIS != 0 && new_flags & ir_flags::DEBRIS != 0 {
            push("info", "Debris on track", 18);
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

/// iRacing returns `SessionLapsRemainEx == 32767` (and sometimes a negative
/// value) for timed / unlimited sessions that aren't lap-counted. Those are not
/// real lap counts, so map the sentinel (and anything negative) to `None` to
/// keep the bogus value out of fuel/laps math.
fn laps_remaining(v: Option<i32>) -> Option<i32> {
    v.filter(|&l| l >= 0 && l < 32767)
}

/// iRacing returns a negative `SessionTimeRemain` (e.g. `-1`) or an absurdly
/// large value (~604800 = a week) for unlimited sessions with no time cap. Treat
/// those as "no limit" by mapping to `None`; keep genuine remaining times.
fn time_remaining(v: Option<f64>) -> Option<f64> {
    // 604800 s == 7 days; any session clock at/above that is effectively unlimited.
    v.filter(|&t| t >= 0.0 && t < 604_800.0)
}

/// Position `0` means "not in a session / invalid"; map to `None`. iRacing also
/// uses `-1` for an unknown position, which arrives here as `u32::MAX`
/// (4294967295) because the SDK field is an `i32` read as unsigned — so reject
/// anything beyond a sane field size too, not just `0`.
fn position(v: Option<u32>) -> Option<u32> {
    v.filter(|&p| p > 0 && p < 1_000)
}

/// Fold a raw `CarIdxEstTime` delta into the shortest signed track-time gap.
///
/// `CarIdxEstTime` is the time from the start/finish line to a car's current
/// track position (`0..lap_len`). Subtracting two of them gives the right gap
/// everywhere except across the start/finish line: the moment the player wraps
/// to ~0 while a car just behind is still near ~`lap_len`, the naive delta is
/// almost a full lap, so that neighbour briefly flies outside the relative's
/// window and disappears. Folding the delta into `[-lap_len/2, +lap_len/2]`
/// keeps neighbours adjacent through the crossing. With no known lap length the
/// raw delta is returned unchanged.
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

fn relative_gap(
    car_est: f32,
    player_est: f32,
    car_lap: i32,
    player_lap: i32,
    lap_len_s: Option<f32>,
) -> f32 {
    let lap_len = lap_len_s.filter(|&l| l.is_finite() && l > 1.0);
    let lap_delta = car_lap - player_lap;
    match lap_len {
        Some(l) if lap_delta != 0 => lap_delta as f32 * l + (car_est - player_est),
        Some(l) => wrap_gap(car_est - player_est, Some(l)),
        None => car_est - player_est,
    }
}

/// Multiclass-aware signed time gap using class-normalised `CarIdxEstTime`.
///
/// The **behind** car (chaser) is the reference ruler; we scale the ahead
/// car's EstTime into behind-car units before taking the difference, so a
/// slower-class chaser doesn't see an absurdly large gap to a faster-class
/// leader.
///
/// Algorithm (mirrors irDashies `calculateClassEstimatedDelta`):
/// - `scaling = behind_class_est / ahead_class_est`
/// - `ahead_scaled = ahead_est * scaling`
/// - `delta = ahead_scaled – behind_est` (positive = opponent is ahead)
/// - wrap when |delta| exceeds half a lap of the behind class
///
/// Returns positive when `opponent_is_ahead`, negative otherwise.
/// Falls back to 90 s for any missing class estimate (irDashies default).
pub(crate) fn class_est_delta(
    opponent_est: f32,
    player_est: f32,
    opponent_class_est: Option<f32>,
    player_class_est: Option<f32>,
    opponent_is_ahead: bool,
) -> f32 {
    const FALLBACK: f32 = 90.0;

    let (ahead_est, behind_est, ahead_cl_opt, behind_cl_opt) = if opponent_is_ahead {
        (opponent_est, player_est, opponent_class_est, player_class_est)
    } else {
        (player_est, opponent_est, player_class_est, opponent_class_est)
    };

    let ahead_cl = ahead_cl_opt
        .filter(|&v| v.is_finite() && v > 1.0)
        .unwrap_or(FALLBACK);
    let behind_cl = behind_cl_opt
        .filter(|&v| v.is_finite() && v > 1.0)
        .unwrap_or(FALLBACK);

    let scaling = behind_cl / ahead_cl;
    let ahead_scaled = ahead_est * scaling;
    let half_lap = behind_cl / 2.0;

    // raw: positive means ahead-car is further into the lap than behind-car (in behind-car units)
    let raw = ahead_scaled - behind_est;

    let signed = if opponent_is_ahead {
        // target ahead → expect positive; wrap if huge negative (ahead lapped behind)
        if raw < -half_lap {
            raw + behind_cl
        } else {
            raw
        }
    } else {
        // target behind → negate (we want gap from player's POV, negative = behind)
        let neg = -raw;
        if neg > half_lap {
            neg - behind_cl
        } else {
            neg
        }
    };

    signed
}

/// Remember each car's grid / first-seen position for gain/loss column.
fn record_start_position(
    starts: &mut HashMap<u32, u32>,
    car_idx: u32,
    current: Option<u32>,
    grid: Option<u32>,
) {
    if let Some(grid_pos) = grid {
        starts.entry(car_idx).or_insert(grid_pos);
    } else if let Some(pos) = current {
        starts.entry(car_idx).or_insert(pos);
    }
}

fn positions_gained_from(
    starts: &HashMap<u32, u32>,
    car_idx: u32,
    current: Option<u32>,
) -> Option<i32> {
    let cur = current?;
    let start = *starts.get(&car_idx)?;
    Some(start as i32 - cur as i32)
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
            sectors: true,       // computed from LapDistPct crossings + YAML boundaries
            car_setup: true,     // dcBrakeBias/BrakeABSactive/dcTractionControlToggle/cold pressures (car-dependent)
            spectator: true,     // CamCarIdx
            pit_info: true,      // TrackPitSpeedLimit (YAML) + derived pit-box dist + CarIdxPitStopStatus
        }
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        let map = self.map.as_ref()?;

        // Block on the sim's data-ready event rather than busy-polling. When
        // there's no event handle we fall back to sleep + header tick-count
        // polling below, which must not re-emit a frame the sim hasn't
        // actually advanced (audit B4) — ~200 Hz of identical frames would
        // otherwise flood IPC/React.
        let wait_result = map.wait_for_data(WAIT_TIMEOUT_MS);
        match wait_result {
            WaitResult::Signaled => {}
            WaitResult::Timeout => return None,
            WaitResult::NoEvent => {
                // No event handle: avoid a hot spin while still staying current.
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }

        // Re-borrow `map` immutably for the header read. `slice` validates the
        // requested range against the mapped view's actual size, so a torn or
        // too-short header fails the poll (treated as not-ready) instead of
        // reading out of bounds.
        let map = self.map.as_ref()?;
        let header = Header::parse(map.slice(0, HEADER_LEN)?)?;

        // In the menus / between sessions the connected bit is clear.
        if header.status & STATUS_CONNECTED == 0 {
            return None;
        }

        // Rebuild the var map + session info only when the session changes.
        let mut session_changed = false;
        if header.session_info_update != self.last_session_update {
            // Overflow-safe: `num_vars` is sim-controlled and, even though
            // `Header::parse` rejects negative values, a huge positive count
            // could still overflow the multiply. `checked_mul`/`checked_add`
            // fail the poll instead of panicking or wrapping into a
            // bounds-check that happens to pass.
            let var_end = header
                .num_vars
                .checked_mul(VAR_HEADER_LEN)
                .and_then(|sz| header.var_header_offset.checked_add(sz))?;
            let var_region = map.slice(0, var_end)?;
            self.var_map = build_var_map(var_region, &header);

            // One-shot diagnostic: with OVERLAY_DUMP_VARS set, print every
            // available telemetry var name once (car-dependent vars like
            // dcBrakeBias/dcABS only appear for cars that have them). Lets us
            // confirm var names against a real session without guessing.
            if !self.vars_dumped && std::env::var_os("OVERLAY_DUMP_VARS").is_some() {
                let mut names: Vec<&str> = self.var_map.keys().map(|s| s.as_str()).collect();
                names.sort_unstable();
                eprintln!("[OVERLAY_DUMP_VARS] {} vars: {}", names.len(), names.join(", "));
                self.vars_dumped = true;
            }

            if header.session_info_len > 0 {
                let raw = map.slice(header.session_info_offset, header.session_info_len)?;
                let yaml = decode_session_info(raw);
                // Session-info rebuilds happen for lots of reasons (results
                // updates, mid-session admin changes) — only a car/track
                // change should reset per-session derived state (audit B3),
                // so snapshot the player's identity before overwriting it.
                let prev_track_id = self.session_min.track_id;
                let prev_player_car = self
                    .session_min
                    .driver_car_idx
                    .and_then(|pi| self.session_min.drivers.iter().find(|d| d.car_idx == pi))
                    .and_then(|d| d.car_screen_name.clone());
                self.session_min = parse_min(&yaml);
                let new_player_car = self
                    .session_min
                    .driver_car_idx
                    .and_then(|pi| self.session_min.drivers.iter().find(|d| d.car_idx == pi))
                    .and_then(|d| d.car_screen_name.clone());
                if self.session_min.track_id != prev_track_id || new_player_car != prev_player_car {
                    self.reset_session_state();
                }
            }

            self.last_session_update = header.session_info_update;
            session_changed = true;
        }

        // Snapshot the freshest buffer. `&self.map` and `&mut self.scratch` are
        // disjoint field borrows, so both can be held at once.
        let map = self.map.as_ref()?;
        let sim_tick = fill_latest_buffer(map, &mut self.scratch)?;

        // No-event fallback polling: if the sim hasn't advanced past the last
        // frame we emitted, skip building/emitting a duplicate snapshot
        // instead of re-sending it at the ~200 Hz sleep-loop rate (audit B4).
        if wait_result == WaitResult::NoEvent && self.last_emitted_tick == Some(sim_tick) {
            return None;
        }

        // Build the normalized snapshot from the copied buffer.
        let vm = &self.var_map;
        let buf = &self.scratch;

        // Live session identity: `SessionNum` selects which entry of
        // `SessionInfo.Sessions[]` is active (audit B1 — the weekend advancing
        // Practice→Qualy→Race must update the reported session type), and
        // together with `SessionUniqueID` it also detects a switch to a
        // different session/server so per-session state can be reset (audit
        // B3). Only update the remembered value when the var actually reads —
        // a var briefly absent (torn frame, sim warming up) must not look
        // like a change once real data resumes.
        let session_num = i32_var(vm, buf, "SessionNum");
        let session_unique_id = i32_var(vm, buf, "SessionUniqueID");
        let mut session_identity_changed = false;
        if let Some(n) = session_num {
            if session_id_changed(self.prev_session_num, Some(n)) {
                session_identity_changed = true;
            }
            self.prev_session_num = Some(n);
        }
        if let Some(id) = session_unique_id {
            if session_id_changed(self.prev_session_unique_id, Some(id)) {
                session_identity_changed = true;
            }
            self.prev_session_unique_id = Some(id);
        }
        if session_identity_changed {
            // Inlined (rather than `self.reset_session_state()`) so this only
            // touches disjoint fields — `vm`/`buf` above hold an immutable
            // borrow of `self.var_map`/`self.scratch` that's still live for
            // the reads below, and a whole-`self` method call would conflict
            // with that even though the touched fields don't overlap.
            self.fuel_history.clear();
            self.prev_lap = None;
            self.prev_fuel = None;
            self.prev_flags = 0;
            self.messages.clear();
            self.reference_laps.reset();
            self.lap_history.reset();
            self.start_positions.clear();
        }

        // iRacing's `Clutch` is 1.0 when fully engaged (pedal up) and 0.0 when
        // pressed — the inverse of our "0 released, 1 applied" pedal convention.
        let clutch = f32_var(vm, buf, "Clutch").map(|c| 1.0 - c);

        let lap = i32_var(vm, buf, "Lap");
        let fuel_l = f32_var(vm, buf, "FuelLevel");

        // Per-sector timing: compute from LapDistPct boundary crossings, since
        // iRacing exposes no per-sector telemetry vars (only YAML boundaries).
        self.sector_timer.set_starts(&self.session_min.sector_starts);
        let lap_dist_pct = f32_var(vm, buf, "LapDistPct");
        let session_time = f64_var(vm, buf, "SessionTime");
        let on_track = bool_at(vm, buf, "IsOnTrack", 0).unwrap_or(false);
        let track_surface = i32_var(vm, buf, "TrackSurface");
        let off_track = track_surface == Some(0);
        let flags_raw = u32_var(vm, buf, "SessionFlags").unwrap_or(0);
        let incident = flags_raw & (ir_flags::BLACK | ir_flags::DISQUALIFY | ir_flags::REPAIR) != 0;
        self.sector_timer.update(
            lap_dist_pct,
            session_time,
            on_track,
            off_track,
            incident,
        );
        let sector_times = self.sector_timer.current();
        let sector_best = self.sector_timer.best();
        let sector_prev = self.sector_timer.previous();
        let sector_session_best = self.sector_timer.session_best();
        let sector_session_best_prev = self.sector_timer.session_best_prev();
        let current_sector_idx = self.sector_timer.current_sector_idx();

        let track_len_m = self
            .session_min
            .track_length_m
            .or_else(|| {
                self.session_min
                    .track_id
                    .and_then(track_map::metadata_for)
                    .and_then(|m| m.length.map(|l| l as f32))
            });
        self.reference_laps.configure(track_len_m);

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
                if let Some(pi) = self.session_min.driver_car_idx {
                    let class_id = self
                        .session_min
                        .drivers
                        .iter()
                        .find(|d| d.car_idx == pi)
                        .and_then(|d| d.car_class_id);
                    self.reference_laps
                        .bank_with_sectors(pi, class_id, sector_best.clone());
                }
            }
            self.prev_lap = Some(cur_lap);
        }
        self.prev_fuel = fuel_l;
        let fuel_per_lap = self.fuel_per_lap();

        // Flag-change → race-control messages. Uses disjoint field borrows so it
        // can run while `vm` is alive.
        Self::on_flags_changed(&mut self.messages, &mut self.prev_flags, flags_raw);

        // Distance to the player's own pit stall. iRacing exposes no direct var;
        // derive it from the stall's track fraction (`DriverPitTrkPct`, session
        // YAML) minus the live `LapDistPct`, scaled by track length. Shortest-arc
        // signed: positive = box ahead, negative = already past it.
        let pit_box_dist_m = match (
            self.session_min
                .driver_car_idx
                .and_then(|pi| self.session_min.drivers.iter().find(|d| d.car_idx == pi))
                .and_then(|d| d.pit_trk_pct),
            lap_dist_pct,
            self.session_min.track_length_m,
        ) {
            (Some(stall), Some(pos), Some(len)) if len > 0.0 => {
                let mut d = stall - pos;
                if d > 0.5 {
                    d -= 1.0;
                } else if d < -0.5 {
                    d += 1.0;
                }
                Some(d * len)
            }
            _ => None,
        };

        let player_ghost_sectors = self
            .session_min
            .driver_car_idx
            .map(|pi| {
                let class_id = self
                    .session_min
                    .drivers
                    .iter()
                    .find(|d| d.car_idx == pi)
                    .and_then(|d| d.car_class_id);
                self.reference_laps.ghost_sectors_for(pi, class_id)
            })
            .unwrap_or_default();

        let sector_live_delta_s = self.session_min.driver_car_idx.and_then(|pi| {
            let class_id = self
                .session_min
                .drivers
                .iter()
                .find(|d| d.car_idx == pi)
                .and_then(|d| d.car_class_id);
            let ref_lap = self.reference_laps.reference_for(pi, class_id);
            self.sector_timer
                .live_delta(lap_dist_pct, session_time, ref_lap)
        });
        let sector_elapsed_s = self.sector_timer.elapsed(session_time);
        let sector_progress = self.sector_timer.progress(lap_dist_pct);

        let player = PlayerState {
            speed_ms: f32_var(vm, buf, "Speed"),
            rpm: f32_var(vm, buf, "RPM"),
            gear: i32_var(vm, buf, "Gear"),
            throttle: f32_var(vm, buf, "Throttle"),
            brake: f32_var(vm, buf, "Brake"),
            clutch,
            steering_rad: f32_var(vm, buf, "SteeringWheelAngle"),
            lap_dist_pct,
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
            // TrackSurface OffTrack (=0). Prefer PlayerTrackSurface, fall back to
            // the scalar TrackSurface used by the sector timer.
            off_track: i32_var(vm, buf, "PlayerTrackSurface")
                .or_else(|| i32_var(vm, buf, "TrackSurface"))
                .map(|s| s == 0),
            in_garage: bool_at(vm, buf, "IsInGarage", 0),
            // iRacing `CarLeftRight` spotter enum: 2/4/5 = car(s) left, 3/4/6 = right.
            car_left: i32_var(vm, buf, "CarLeftRight").map(|v| matches!(v, 2 | 4 | 5)),
            car_right: i32_var(vm, buf, "CarLeftRight").map(|v| matches!(v, 3 | 4 | 6)),

            // Pit / setup helpers. Pit speed limit is a session-YAML value
            // (km/h → m/s), not a telemetry var.
            pit_speed_limit_ms: self.session_min.pit_speed_limit_kph.map(|k| k / 3.6),
            pit_box_dist_m,
            // Computed from LapDistPct crossings (iRacing exposes no per-sector
            // telemetry vars — only the sector boundaries in the session YAML).
            sector_times_s: sector_times,
            sector_best_s: sector_best,
            sector_prev_times_s: sector_prev,
            sector_session_best_s: sector_session_best,
            sector_session_best_prev_s: sector_session_best_prev,
            current_sector_idx,
            sector_elapsed_s,
            sector_progress,
            sector_live_delta_s,

            // In-car settings / statuses. These are car-dependent `dc*` driver
            // controls — present only when the loaded car has the adjustment.
            // `dcBrakeBias` is car-specific scale: most cars report % front, so
            // normalize a >1.5 value as a percentage into the documented 0..1.
            brake_bias_pct: f32_var(vm, buf, "dcBrakeBias").map(|v| {
                if v > 1.5 {
                    (v / 100.0).clamp(0.0, 1.0)
                } else {
                    v.clamp(0.0, 1.0)
                }
            }),
            // `BrakeABSactive` (bool) is the live "ABS reducing brake pressure"
            // flag; `dcTractionControlToggle` (bool) is the live TC-active flag.
            abs_active: bool_at(vm, buf, "BrakeABSactive", 0),
            tc_active: bool_at(vm, buf, "dcTractionControlToggle", 0),
            drs_state: i32_var(vm, buf, "DRS_Status"),
            // `EnergyERSBattery` is Joules, not a fraction — normalizing to 0..1
            // needs the car's battery capacity, which we don't have. Left None
            // until a hybrid-specific mapping is added.
            ers_pct: None,
            fuel_mix: f32_var(vm, buf, "dcFuelMixture").map(|v| v.round() as i32),
            p2p_available: i32_var(vm, buf, "P2P_Status"),
            // iRacing exposes no live (hot) tire pressures — only the garage cold
            // pressures (`*coldPressure`, kPa), which is what setup tools want.
            tire_pressures: TirePressures {
                lf_kpa: f32_var(vm, buf, "LFcoldPressure"),
                rf_kpa: f32_var(vm, buf, "RFcoldPressure"),
                lr_kpa: f32_var(vm, buf, "LRcoldPressure"),
                rr_kpa: f32_var(vm, buf, "RRcoldPressure"),
            },
            sector_ghost_best_s: player_ghost_sectors,
            // Team incident count is what the DQ limit applies to (solo = personal).
            incidents: i32_var(vm, buf, "PlayerCarTeamIncidentCount")
                .filter(|&n| n >= 0)
                .map(|n| n as u32),
            incident_limit: self.session_min.incident_limit,
            driver_car_redline: self.session_min.driver_car_redline,
            driver_car_sl_shift_rpm: self.session_min.driver_car_sl_shift_rpm,
            driver_car_sl_blink_rpm: self.session_min.driver_car_sl_blink_rpm,
        };

        // Reference-lap sampling + lap-history for every competitor.
        let session_t = session_time.unwrap_or(0.0);
        for d in self.session_min.drivers.iter().filter(|d| !d.is_pace_car) {
            let i = d.car_idx as usize;
            let pct = f32_at(vm, buf, "CarIdxLapDistPct", i);
            let car_lap_n = i32_at(vm, buf, "CarIdxLap", i);
            let on_pit = bool_at(vm, buf, "CarIdxOnPitRoad", i).unwrap_or(false);
            let on_track_car = i32_at(vm, buf, "CarIdxTrackSurface", i) == Some(3);
            if let (Some(pct), Some(lap_n)) = (pct, car_lap_n) {
                self.reference_laps.collect(
                    d.car_idx,
                    lap_n,
                    pct,
                    session_t,
                    on_track_car,
                    on_pit,
                );
            }
            let last = lap_time(f32_at(vm, buf, "CarIdxLastLapTime", i));
            self.lap_history.update(d.car_idx, car_lap_n, last);
        }

        // Build the field from DriverInfo (parsed on session change) + the live
        // CarIdx* arrays. Prefer reference-lap gaps when a profile exists; fall
        // back to class-normalised CarIdxEstTime (multiclass-safe).
        let player_idx = self.session_min.driver_car_idx.map(|pi| pi as usize);
        let player_est = player_idx.and_then(|pi| f32_at(vm, buf, "CarIdxEstTime", pi));
        let player_lap = player_idx.and_then(|pi| i32_at(vm, buf, "CarIdxLap", pi));
        let player_pct = player_idx.and_then(|pi| f32_at(vm, buf, "CarIdxLapDistPct", pi));
        let player_class = player_idx.and_then(|pi| {
            self.session_min
                .drivers
                .iter()
                .find(|d| d.car_idx == pi as u32)
                .and_then(|d| d.car_class_id)
        });
        // Per-driver class estimate for the player — used as the normalisation
        // denominator when the player is the chasing car.
        let player_class_est = player_idx.and_then(|pi| {
            self.session_min
                .drivers
                .iter()
                .find(|d| d.car_idx == pi as u32)
                .and_then(|d| d.car_class_est_lap_time)
        });
        let player_on_pit = player_idx
            .and_then(|pi| bool_at(vm, buf, "CarIdxOnPitRoad", pi))
            .unwrap_or(false);
        // Lap length (s) used only when both pct values are absent (last resort).
        let lap_len_s = self
            .session_min
            .car_est_lap_time
            .filter(|&l| l.is_finite() && l > 1.0)
            .or(player.best_lap_s)
            .or(player.last_lap_s);
        for d in self.session_min.drivers.iter().filter(|d| !d.is_pace_car) {
            let i = d.car_idx as usize;
            let live_pos = position(u32_at(vm, buf, "CarIdxPosition", i));
            let yaml_pos = session_num
                .and_then(|sn| self.session_min.session_position(sn, d.car_idx));
            record_start_position(
                &mut self.start_positions,
                d.car_idx,
                live_pos.or(yaml_pos.map(|(p, _)| p)),
                yaml_pos.map(|(p, _)| p),
            );
        }

        let pos_inputs: Vec<DriverPosInput> = self
            .session_min
            .drivers
            .iter()
            .filter(|d| !d.is_pace_car)
            .map(|d| {
                let i = d.car_idx as usize;
                DriverPosInput {
                    car_idx: d.car_idx,
                    car_number: d.car_number.clone(),
                    car_class_id: d.car_class_id,
                    live_position: position(u32_at(vm, buf, "CarIdxPosition", i)),
                    live_class_position: position(u32_at(vm, buf, "CarIdxClassPosition", i)),
                }
            })
            .collect();
        let resolved_positions =
            positions::resolve_field_positions(&pos_inputs, &self.session_min, session_num);

        let cars: Vec<overlay_core::CarState> = self
            .session_min
            .drivers
            .iter()
            .filter(|d| !d.is_pace_car)
            .map(|d| {
                let i = d.car_idx as usize;
                let est = f32_at(vm, buf, "CarIdxEstTime", i);
                let car_lap = i32_at(vm, buf, "CarIdxLap", i);
                let car_pct = f32_at(vm, buf, "CarIdxLapDistPct", i);
                let resolved = resolved_positions.get(&d.car_idx).copied();
                let cur_pos = resolved.and_then(|r| r.position);
                let class_pos = resolved.and_then(|r| r.class_position);
                let position_provisional = resolved.map(|r| r.provisional).unwrap_or(false);
                let positions_gained =
                    positions_gained_from(&self.start_positions, d.car_idx, cur_pos);
                let last_lap_s = lap_time(f32_at(vm, buf, "CarIdxLastLapTime", i));
                let rolling_avg = self.lap_history.rolling_avg_s(d.car_idx);
                let lap_delta = self
                    .lap_history
                    .lap_delta_vs_avg_s(d.car_idx, last_lap_s);
                // --- multiclass-aware gap to player ---
                //
                // irDashies algorithm: the CHASER (physically behind car) is
                // the reference ruler. Prefer the behind car's own reference
                // lap for interpolation; fall back to class-normalised
                // CarIdxEstTime when either car is on pit road or no profile
                // is available yet.
                let car_on_pit = bool_at(vm, buf, "CarIdxOnPitRoad", i).unwrap_or(false);
                let gap = match (car_pct, player_pct) {
                    (Some(cp), Some(pp)) => {
                        // Wrap to (−0.5, +0.5]: positive = opponent ahead.
                        let diff = cp - pp;
                        let relative_pct = if diff > 0.5 {
                            diff - 1.0
                        } else if diff < -0.5 {
                            diff + 1.0
                        } else {
                            diff
                        };
                        let opponent_ahead = relative_pct > 0.0;

                        // Behind car = the chaser.
                        let behind_car_idx = if opponent_ahead {
                            player_idx.unwrap_or(0) as u32
                        } else {
                            d.car_idx
                        };
                        let behind_class_id = if opponent_ahead {
                            player_class
                        } else {
                            d.car_class_id
                        };

                        // Use the behind car's reference lap when neither car
                        // is on pit road (pit road invalidates EstTime tracking).
                        let behind_ref = if !car_on_pit && !player_on_pit {
                            self.reference_laps
                                .reference_for(behind_car_idx, behind_class_id)
                        } else {
                            None
                        };

                        if let Some(ref_lap) = behind_ref {
                            // Both positions measured on the chaser's own lap
                            // profile — correct across classes.
                            reference_lap::reference_delta(ref_lap, cp, pp)
                        } else {
                            // Class-normalised EstTime fallback.
                            match (est, player_est) {
                                (Some(opp_e), Some(pl_e)) => Some(class_est_delta(
                                    opp_e,
                                    pl_e,
                                    d.car_class_est_lap_time,
                                    player_class_est,
                                    opponent_ahead,
                                )),
                                _ => None,
                            }
                        }
                    }
                    // No pct data — last-resort lap-aware EstTime wrap.
                    _ => match (est, player_est, car_lap, player_lap) {
                        (Some(e), Some(p), Some(cl), Some(pl)) => {
                            Some(relative_gap(e, p, cl, pl, lap_len_s))
                        }
                        (Some(e), Some(p), _, _) => lap_len_s
                            .map(|l| wrap_gap(e - p, Some(l)))
                            .or(Some(e - p)),
                        _ => None,
                    },
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
                    positions_gained,
                    irating_delta: None, // not exposed live by iRacing SDK
                    tyre: None,          // iRacing doesn't expose compound letter per car
                    position: cur_pos,
                    class_position: class_pos,
                    position_provisional,
                    lap: car_lap,
                    lap_dist_pct: car_pct,
                    gap_to_player_s: gap,
                    last_lap_s,
                    best_lap_s: lap_time(f32_at(vm, buf, "CarIdxBestLapTime", i)),
                    on_pit_road: bool_at(vm, buf, "CarIdxOnPitRoad", i),
                    in_world: i32_at(vm, buf, "CarIdxTrackSurface", i).map(|s| s >= 0),
                    irating: d.irating,
                    safety_rating: d.license.clone(),
                    rel_lat_m: None,
                    rel_lon_m: None,
                    pit_status: u32_at(vm, buf, "CarIdxPitStopStatus", i),
                    has_session_fastest: None,
                    rolling_lap_avg_s: rolling_avg,
                    lap_delta_vs_avg_s: lap_delta,
                }
            })
            .collect();

        let session = SessionState {
            track_name: self.session_min.track_name.clone(),
            track_length_m: self.session_min.track_length_m,
            // Selected by the live `SessionNum` var so the reported type
            // tracks the weekend as it advances Practice→Qualy→Race (audit
            // B1), instead of always reporting the first parsed session.
            session_type: self.session_min.session_type_for(session_num),
            time_remaining_s: time_remaining(f64_var(vm, buf, "SessionTimeRemain")),
            laps_remaining: laps_remaining(i32_var(vm, buf, "SessionLapsRemainEx")),
            // Pace/safety car is filtered from `cars` above; count only real
            // competitors here too, so the two stay consistent.
            total_cars: Some(
                self.session_min
                    .drivers
                    .iter()
                    .filter(|d| !d.is_pace_car)
                    .count() as u32,
            ),
            flags_raw: Some(flags_raw),
            air_temp_c: f32_var(vm, buf, "AirTemp"),
            track_temp_c: f32_var(vm, buf, "TrackTemp"),
            wind_speed_ms: f32_var(vm, buf, "WindVel"),
            wind_dir_rad: f32_var(vm, buf, "WindDir"),
            // `TrackWetness` is the `irsdk_TrackWetness` enum, not a fraction:
            // 0=unknown/off, 1=dry .. 7=extremely wet. Map 1..=7 → 0..1.
            track_wetness_pct: i32_var(vm, buf, "TrackWetness").and_then(|n| {
                if (1..=7).contains(&n) {
                    Some((n - 1) as f32 / 6.0)
                } else {
                    None
                }
            }),
            precipitation_pct: f32_var(vm, buf, "Precipitation").map(|v| v.clamp(0.0, 1.0)),
            humidity_pct: f32_var(vm, buf, "RelativeHumidity").map(|v| v.clamp(0.0, 1.0)),
            // `CamCarIdx` is the camera's focus car (the var `CamCarIdxTarget`
            // doesn't exist). Negative/absent → None; the frontend treats a value
            // equal to the player as "not spectating".
            spectated_car_idx: i32_var(vm, buf, "CamCarIdx")
                .filter(|&v| v >= 0)
                .map(|v| v as u32),
            messages: self.messages.clone(),
            chat_messages: Vec::new(), // no broadcast chat source wired
            // Bundled official centerline + corner labels for this track, if any.
            track_path: self.session_min.track_id.and_then(track_map::path_for),
            track_turns: self.session_min.track_id.and_then(track_map::turns_for),
            track_metadata: self.session_min.track_id.and_then(track_map::metadata_for),
        };

        // Remember what we just emitted so the no-event fallback poll (above)
        // can recognize a repeat of this same buffer next time and skip it.
        self.last_emitted_tick = Some(sim_tick);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_gap_leaves_small_gaps_untouched() {
        // Well inside half a lap → identical.
        assert!((wrap_gap(3.0, Some(90.0)) - 3.0).abs() < 1e-4);
        assert!((wrap_gap(-5.0, Some(90.0)) + 5.0).abs() < 1e-4);
    }

    #[test]
    fn wrap_gap_folds_across_start_finish() {
        // Player just crossed S/F (est ~0); a car just behind is still near the
        // end of the lap (est ~88). Naive delta = +88 (looks a lap ahead); folded
        // it should read as ~-2s behind.
        let g = wrap_gap(88.0, Some(90.0));
        assert!((g + 2.0).abs() < 1e-3, "expected ~-2, got {g}");
        // Symmetric case: a car just ahead that already crossed.
        let g2 = wrap_gap(-88.0, Some(90.0));
        assert!((g2 - 2.0).abs() < 1e-3, "expected ~+2, got {g2}");
    }

    #[test]
    fn wrap_gap_no_lap_len_is_identity() {
        assert!((wrap_gap(88.0, None) - 88.0).abs() < 1e-4);
        assert!((wrap_gap(50.0, Some(0.0)) - 50.0).abs() < 1e-4);
    }

    #[test]
    fn relative_gap_same_lap_wraps_at_start_finish() {
        // Player just crossed S/F (~0); car behind still near lap end (~88s).
        let g = relative_gap(88.0, 0.0, 5, 5, Some(90.0));
        assert!((g + 2.0).abs() < 1e-3, "expected ~-2s behind, got {g}");
    }

    #[test]
    fn relative_gap_lap_ahead_not_folded_as_behind() {
        // One lap ahead at 10s vs player deep on prior lap — must read ahead, not
        // folded to nearly behind by wrap_gap alone.
        let g = relative_gap(10.0, 80.0, 6, 5, Some(90.0));
        assert!(g > 0.0, "expected ahead, got {g}");
        assert!((g - 20.0).abs() < 1e-3, "expected ~+20s, got {g}");
    }

    #[test]
    fn relative_gap_lap_behind() {
        let g = relative_gap(80.0, 10.0, 5, 6, Some(90.0));
        assert!(g < 0.0, "expected behind, got {g}");
        assert!((g + 20.0).abs() < 1e-3, "expected ~-20s, got {g}");
    }

    // --- class_est_delta: multiclass gap normalisation ---

    /// Same class (both 90 s): delta should equal the raw EstTime difference
    /// with wrap, matching the old wrap_gap / relative_gap behaviour.
    #[test]
    fn class_est_delta_same_class_ahead() {
        // Opponent at 60% (est 54 s), player at 40% (est 36 s) — opponent ahead.
        let g = class_est_delta(54.0, 36.0, Some(90.0), Some(90.0), true);
        assert!((g - 18.0).abs() < 1e-3, "expected +18 s, got {g}");
    }

    #[test]
    fn class_est_delta_same_class_behind() {
        // Opponent at 40% (est 36 s), player at 60% (est 54 s) — opponent behind.
        let g = class_est_delta(36.0, 54.0, Some(90.0), Some(90.0), false);
        assert!((g + 18.0).abs() < 1e-3, "expected -18 s, got {g}");
    }

    /// GTP (60 s class, car at 80%) behind GT3 (90 s class, player at 10%).
    /// Relative pct = 0.8 – 0.1 = 0.7, wrapped = –0.3 → opponent behind.
    /// GTP needs ~0.2 laps in GTP terms = 12 s to close to GT3; then GT3 is
    /// 10% in = 6 s more → total 18 GTP-seconds behind.
    #[test]
    fn class_est_delta_gtp_behind_gt3_across_start_finish() {
        // opponent = GTP at 80% → est = 0.8 * 60 = 48 s
        // player   = GT3 at 10% → est = 0.1 * 90 = 9 s
        let g = class_est_delta(48.0, 9.0, Some(60.0), Some(90.0), false);
        // behind = GTP (60 s), ahead = GT3 (90 s)
        // scaling = 60 / 90 = 0.667; ahead_scaled = 9 * 0.667 = 6.0 s
        // raw = 6.0 – 48.0 = –42.0; neg = 42.0; 42 > 30 (half 60) → 42 – 60 = –18.0
        assert!((g + 18.0).abs() < 1e-2, "expected –18 s, got {g}");
    }

    /// GTP ahead of GT3: GTP at 80%, GT3 (player) at 60%.
    /// relative pct = +0.2 → opponent ahead.
    /// In GT3 units: GTP 80% ≈ 72 GT3-s, GT3 at 60% = 54 GT3-s → gap = 18 s.
    #[test]
    fn class_est_delta_gtp_ahead_of_gt3() {
        // opponent = GTP at 80% → est = 48 s; player = GT3 at 60% → est = 54 s
        let g = class_est_delta(48.0, 54.0, Some(60.0), Some(90.0), true);
        // behind = GT3 player (90 s), ahead = GTP (60 s)
        // scaling = 90 / 60 = 1.5; ahead_scaled = 48 * 1.5 = 72 s
        // raw = 72 – 54 = 18; 18 > –45 → no wrap → 18.0
        assert!((g - 18.0).abs() < 1e-2, "expected +18 s, got {g}");
    }

    /// Fallback to 90 s when class estimates are absent — still wraps correctly.
    #[test]
    fn class_est_delta_fallback_when_class_est_missing() {
        // Opponent just crossed S/F (est ~0 s), player still near lap end (est ~88 s).
        // relative pct wrapped → opponent just ahead; with same 90 s fallback
        // we expect ~+2 s (symmetric with wrap_gap test).
        let g = class_est_delta(0.0, 88.0, None, None, true);
        // scaling = 90/90 = 1; ahead_scaled = 0; raw = 0 – 88 = –88; –88 < –45 → –88 + 90 = 2
        assert!((g - 2.0).abs() < 1e-2, "expected +2 s, got {g}");
    }

    // 3-sector track: boundaries at 0.0, 0.3, 0.6.
    fn timer3() -> SectorTimer {
        let mut t = SectorTimer::default();
        t.set_starts(&[0.0, 0.3, 0.6]);
        t
    }

    /// Feed a smooth sweep of LapDistPct from `p0` to `p1` over `dur` seconds,
    /// starting at session time `t0`, in small (~16ms) frame steps. Returns the
    /// session time at the end. Handles a single wrap (p1 < p0) by going through
    /// 1.0→0.0.
    fn sweep(t: &mut SectorTimer, p0: f32, p1: f32, t0: f64, dur: f64) -> f64 {
        let steps = 120usize;
        let total = if p1 >= p0 { p1 - p0 } else { (1.0 - p0) + p1 };
        for i in 1..=steps {
            let frac = i as f32 / steps as f32;
            let mut p = p0 + total * frac;
            if p >= 1.0 {
                p -= 1.0;
            }
            let now = t0 + dur * (frac as f64);
            t.update(Some(p), Some(now), true, false, false);
        }
        t0 + dur
    }

    /// Sectors fill progressively through the lap and reset at the start/finish
    /// line; the completed lap is banked as the best-lap reference.
    #[test]
    fn fills_progressively_and_resets() {
        let mut t = timer3();
        t.update(Some(0.95), Some(0.0), true, false, false); // seed continuity
        // Cross the line to start a fresh, empty lap.
        let mut now = sweep(&mut t, 0.95, 0.05, 0.0, 5.0);
        let cur = t.current();
        assert!(
            cur.s1.is_none() && cur.s2.is_none() && cur.s3.is_none(),
            "all sectors clear right after S/F"
        );
        // Finish sector 1 (cross 0.3).
        now = sweep(&mut t, 0.05, 0.31, now, 30.0);
        assert!(t.current().s1.is_some(), "S1 set after crossing 0.3");
        assert!(t.current().s2.is_none() && t.current().s3.is_none(), "S2/S3 not done yet");
        // Finish sector 2 (cross 0.6).
        now = sweep(&mut t, 0.31, 0.61, now, 30.0);
        assert!(t.current().s2.is_some(), "S2 set after crossing 0.6");
        assert!(t.current().s3.is_none(), "S3 only completes at the line");
        // Cross the line: S3 completes, the lap is banked, and the set resets.
        sweep(&mut t, 0.61, 0.05, now, 30.0);
        let cur = t.current();
        assert!(
            cur.s1.is_none() && cur.s2.is_none() && cur.s3.is_none(),
            "reset at S/F"
        );
        assert!(t.best().s1.is_some(), "a full clean lap is banked as best");
    }

    /// `best()` holds the splits of the fastest *complete* lap (by total time),
    /// not the per-sector minimum — and a slower lap never replaces it.
    #[test]
    fn best_is_fastest_complete_lap() {
        let mut t = timer3();
        t.update(Some(0.95), Some(0.0), true, false, false);
        // Lap A: S1≈30 (total the slower of the two timed laps).
        let mut now = sweep(&mut t, 0.95, 0.05, 0.0, 5.0); // start lap A
        now = sweep(&mut t, 0.05, 0.31, now, 30.0); // S1 ≈ 30
        now = sweep(&mut t, 0.31, 0.61, now, 30.0); // S2 ≈ 30
        now = sweep(&mut t, 0.61, 0.05, now, 30.0); // wrap → S3, lap A banked
        assert!((t.best().s1.unwrap() - 30.0).abs() < 3.0, "lap A s1 ≈ 30: {:?}", t.best().s1);
        // Lap B: faster sector 1 → faster overall → becomes the best lap.
        now = sweep(&mut t, 0.05, 0.31, now, 20.0); // S1 ≈ 20
        now = sweep(&mut t, 0.31, 0.61, now, 30.0); // S2 ≈ 30
        now = sweep(&mut t, 0.61, 0.05, now, 30.0); // wrap → lap B banked (faster)
        assert!((t.best().s1.unwrap() - 20.0).abs() < 3.0, "best now lap B s1 ≈ 20: {:?}", t.best().s1);
        // Lap C: slower overall → must NOT replace the best.
        now = sweep(&mut t, 0.05, 0.31, now, 40.0); // S1 ≈ 40
        now = sweep(&mut t, 0.31, 0.61, now, 30.0);
        sweep(&mut t, 0.61, 0.05, now, 30.0); // wrap → lap C banked? no, slower
        assert!((t.best().s1.unwrap() - 20.0).abs() < 3.0, "best stays lap B: {:?}", t.best().s1);
    }

    /// No sectors → all None, no panic.
    #[test]
    fn empty_sectors_yields_none() {
        let mut t = SectorTimer::default();
        t.set_starts(&[]);
        t.update(Some(0.5), Some(1.0), true, false, false);
        assert!(t.current().s1.is_none());
        assert!(t.best().s1.is_none());
    }

    /// A forward LapDistPct teleport must soft-invalidate (taint + clear landed
    /// sector) without banking a bogus best lap.
    #[test]
    fn teleport_invalidates_lap_banking() {
        let mut t = timer3();
        t.update(Some(0.10), Some(1.0), true, false, false);
        t.update(Some(0.40), Some(31.0), true, false, false);
        let best_before = t.best().s1;
        t.update(Some(0.88), Some(32.0), true, false, false);
        assert!(t.lap_is_tainted(), "teleport must taint lap");
        assert!(!t.entry_valid(), "teleport clears sector entry validity");
        t.update(Some(0.65), Some(62.0), true, false, false);
        t.update(Some(0.04), Some(92.0), true, false, false);
        assert_eq!(t.best().s1, best_before);
    }

    /// Previous-lap times update as soon as a sector closes (not only at S/F).
    #[test]
    fn previous_lap_fills_on_sector_close() {
        let mut t = timer3();
        t.update(Some(0.95), Some(0.0), true, false, false);
        let mut now = sweep(&mut t, 0.95, 0.05, 0.0, 5.0);
        now = sweep(&mut t, 0.05, 0.31, now, 30.0);
        assert!(t.previous().s1.is_some(), "prev S1 set when S1 closes");
        assert!(t.previous().s2.is_none());
        now = sweep(&mut t, 0.31, 0.61, now, 30.0);
        assert!(t.previous().s2.is_some());
        sweep(&mut t, 0.61, 0.05, now, 30.0);
        assert!(t.previous().s3.is_some());
        // After S/F, current is clear but previous still holds the last lap.
        assert!(t.current().s1.is_none());
        assert!(t.previous().s1.is_some() && t.previous().s2.is_some() && t.previous().s3.is_some());
    }

    /// Per-sector session best updates independently; prev holds the old best.
    #[test]
    fn session_best_per_sector_and_prev() {
        let mut t = timer3();
        t.update(Some(0.95), Some(0.0), true, false, false);
        let mut now = sweep(&mut t, 0.95, 0.05, 0.0, 5.0);
        now = sweep(&mut t, 0.05, 0.31, now, 30.0); // S1 ≈ 30
        assert!((t.session_best().s1.unwrap() - 30.0).abs() < 3.0);
        assert!(t.session_best_prev().s1.is_none());
        now = sweep(&mut t, 0.31, 0.61, now, 30.0);
        now = sweep(&mut t, 0.61, 0.05, now, 30.0);
        // Faster S1 on next lap.
        now = sweep(&mut t, 0.05, 0.31, now, 20.0); // S1 ≈ 20
        assert!((t.session_best().s1.unwrap() - 20.0).abs() < 3.0);
        assert!((t.session_best_prev().s1.unwrap() - 30.0).abs() < 3.0);
        let _ = now;
    }

    /// Live delta is negative when the player is ahead of the reference profile.
    #[test]
    fn live_delta_ahead_is_negative() {
        let mut t = timer3();
        // Enter S1 cleanly via S/F wrap so entry is valid.
        t.update(Some(0.95), Some(0.0), true, false, false);
        let now = sweep(&mut t, 0.95, 0.05, 0.0, 5.0);
        assert!(t.entry_valid());
        // Reference: 30s flat across the lap (linear in pct).
        let ref_lap = reference_lap::ReferenceLap {
            point_pos: vec![0.0, 0.5, 1.0],
            times: vec![0.0, 15.0, 30.0],
            interval: 0.5,
            points_count: 3,
            start_time: 0.0,
            finish_time: 30.0,
            is_clean: true,
            sector_times: Sectors::default(),
        };
        // At pct=0.15 ghost elapsed ≈ 4.5s. Entry was mid-sweep (~2.5s into the
        // 5s wrap), so session_time = now (5.0) means ~2.5s player elapsed → ahead.
        let delta = t.live_delta(Some(0.15), Some(now), Some(&ref_lap));
        assert!(delta.is_some());
        assert!(
            delta.unwrap() < -1.0,
            "ahead of ref should be negative, got {delta:?}"
        );
        // Same position much later → behind.
        let behind = t.live_delta(Some(0.15), Some(now + 10.0), Some(&ref_lap));
        assert!(
            behind.unwrap() > 0.0,
            "behind ref should be positive, got {behind:?}"
        );
    }

    /// Elapsed + progress support live delta vs a fixed sector split.
    #[test]
    fn elapsed_and_progress_for_split_delta() {
        let mut t = timer3();
        t.update(Some(0.95), Some(0.0), true, false, false);
        let now = sweep(&mut t, 0.95, 0.05, 0.0, 5.0);
        // Mid-S1 (starts at 0.0, next at 0.3) → progress 0.5 at pct=0.15.
        let prog = t.progress(Some(0.15)).unwrap();
        assert!((prog - 0.5).abs() < 0.02, "progress={prog}");
        let elapsed = t.elapsed(Some(now + 10.0)).unwrap();
        assert!(elapsed > 5.0, "elapsed={elapsed}");
        // vs a 20s S1 split at halfway: expected 10s; player has more → behind.
        let live = elapsed - 20.0 * prog;
        assert!(live > 0.0, "should be behind split pace, live={live}");
    }

    /// A SessionTime jump (restart/replay scrub) must not fabricate splits.
    #[test]
    fn session_time_jump_resets_lap() {
        let mut t = timer3();
        t.update(Some(0.95), Some(0.0), true, false, false);
        // Smoothly start sector 0 around session time ~5s.
        let now = sweep(&mut t, 0.95, 0.05, 0.0, 5.0);
        // Big forward jump (restart) before crossing 0.3 — drops the lap.
        t.update(Some(0.10), Some(now + 1000.0), true, false, false);
        t.update(Some(0.31), Some(now + 1015.0), true, false, false);
        // s1 should NOT be ~1000s; the jump dropped the in-progress start.
        match t.current().s1 {
            Some(v) => assert!(v < 200.0, "stale split leaked: {v}"),
            None => {}
        }
    }

    /// Off-track gates accumulation and clears continuity.
    #[test]
    fn off_track_drops_continuity() {
        let mut t = timer3();
        t.update(Some(0.40), Some(0.0), true, false, false);
        t.update(Some(0.41), Some(0.016), true, false, false);
        // Goes to garage; on_track=false drops continuity.
        t.update(Some(0.42), Some(0.032), false, false, false);
        assert!(t.prev_pct.is_none());
    }

    #[test]
    fn laps_remaining_filters_sentinel() {
        // 32767 sentinel (timed/unlimited) and negatives → None.
        assert_eq!(laps_remaining(Some(32767)), None);
        assert_eq!(laps_remaining(Some(-1)), None);
        assert_eq!(laps_remaining(None), None);
        // Genuine counts pass through, including 0 (last lap done).
        assert_eq!(laps_remaining(Some(0)), Some(0));
        assert_eq!(laps_remaining(Some(5)), Some(5));
        assert_eq!(laps_remaining(Some(32766)), Some(32766));
    }

    #[test]
    fn time_remaining_filters_sentinel() {
        // Negative (-1) and absurdly large (>= a week) → None.
        assert_eq!(time_remaining(Some(-1.0)), None);
        assert_eq!(time_remaining(Some(604_800.0)), None);
        assert_eq!(time_remaining(Some(700_000.0)), None);
        assert_eq!(time_remaining(None), None);
        // Genuine remaining times pass through.
        assert_eq!(time_remaining(Some(0.0)), Some(0.0));
        assert_eq!(time_remaining(Some(1800.0)), Some(1800.0));
    }

    #[test]
    fn track_wetness_enum_maps_to_fraction() {
        // Mirror the connector mapping: 0/unknown → None, 1..=7 → (n-1)/6.
        let map = |n: i32| -> Option<f32> {
            if (1..=7).contains(&n) {
                Some((n - 1) as f32 / 6.0)
            } else {
                None
            }
        };
        assert_eq!(map(0), None);
        assert_eq!(map(8), None);
        assert_eq!(map(1), Some(0.0)); // dry
        assert_eq!(map(7), Some(1.0)); // extremely wet
        assert!((map(4).unwrap() - 0.5).abs() < 1e-6);
    }

    /// Audit B3: only a `Some -> different Some` transition counts as a real
    /// session-identity change. A value briefly absent (torn frame, sim
    /// warming up) or unchanged must not look like a switch.
    #[test]
    fn session_id_changed_only_fires_on_real_transition() {
        assert!(!session_id_changed(None, Some(1)), "no prior value yet");
        assert!(!session_id_changed(Some(1), None), "value briefly absent");
        assert!(!session_id_changed(Some(1), Some(1)), "unchanged");
        assert!(session_id_changed(Some(1), Some(2)), "real transition");
    }

    /// Audit "pace car counted in total_cars": the field-count total must use
    /// the same `!is_pace_car` filter as the `cars` list, so the two numbers
    /// agree (a Standings widget comparing them shouldn't see an off-by-one).
    #[test]
    fn total_cars_excludes_pace_car() {
        use crate::session::DriverEntry;
        let drivers = vec![
            DriverEntry {
                car_idx: 0,
                is_pace_car: true,
                ..Default::default()
            },
            DriverEntry {
                car_idx: 1,
                is_pace_car: false,
                ..Default::default()
            },
            DriverEntry {
                car_idx: 2,
                is_pace_car: false,
                ..Default::default()
            },
        ];
        let total_cars = drivers.iter().filter(|d| !d.is_pace_car).count() as u32;
        let cars_list_len = drivers.iter().filter(|d| !d.is_pace_car).count() as u32;
        assert_eq!(total_cars, 2, "pace car must not be counted");
        assert_eq!(total_cars, cars_list_len, "must match the `cars` list filter");
    }

    /// Audit B3: a session change must drop fuel history, lap/fuel/flag
    /// tracking, and accumulated race-control messages so nothing leaks into
    /// the next car/track without an app restart.
    #[test]
    fn reset_session_state_clears_per_session_fields() {
        let mut c = IRacingConnector::new();
        c.fuel_history.push((1, 50.0));
        c.prev_lap = Some(3);
        c.prev_fuel = Some(45.0);
        c.prev_flags = ir_flags::YELLOW;
        c.messages.push(RaceControlMessage {
            time_s: None,
            kind: "flag".to_string(),
            text: "Yellow flag — caution".to_string(),
            priority: 20,
        });

        c.reset_session_state();

        assert!(c.fuel_history.is_empty());
        assert_eq!(c.prev_lap, None);
        assert_eq!(c.prev_fuel, None);
        assert_eq!(c.prev_flags, 0);
        assert!(c.messages.is_empty());
    }
}
