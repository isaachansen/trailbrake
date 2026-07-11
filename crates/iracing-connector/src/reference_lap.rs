//! Per-class reference lap profiles for multiclass gap interpolation.
//!
//! Records `(lap_dist_pct, session_time)` in ~10 m buckets during each lap,
//! then interpolates opponent position on a best-lap profile when `CarIdxLap`
//! differs — more accurate than raw `CarIdxEstTime` alone.

use std::collections::HashMap;

use overlay_core::Sectors;

const TARGET_SPACING_M: f32 = 10.0;

/// One lap's timing profile: session-relative times at fixed lap-fraction buckets.
#[derive(Clone, Debug)]
pub struct ReferenceLap {
    /// Lap fraction at each bucket (monotonic within a lap).
    pub point_pos: Vec<f32>,
    /// Elapsed session time at each bucket, relative to `start_time`.
    pub times: Vec<f32>,
    pub interval: f32,
    pub points_count: usize,
    pub start_time: f64,
    pub finish_time: f64,
    pub is_clean: bool,
    /// Sector splits when this lap was banked as best (for ghost comparison).
    pub sector_times: Sectors,
}

impl ReferenceLap {
    fn empty() -> Self {
        Self {
            point_pos: Vec::new(),
            times: Vec::new(),
            interval: 0.0,
            points_count: 0,
            start_time: -1.0,
            finish_time: -1.0,
            is_clean: false,
            sector_times: Sectors::default(),
        }
    }
}

/// In-session reference lap registry (slow-path updates only).
#[derive(Default)]
pub struct ReferenceLapStore {
    track_length_m: f32,
    points_count: usize,
    interval: f32,
    active: HashMap<u32, ReferenceLap>,
    best_by_car: HashMap<u32, ReferenceLap>,
    best_by_class: HashMap<u32, ReferenceLap>,
    prev_lap: HashMap<u32, i32>,
}

impl ReferenceLapStore {
    pub fn reset(&mut self) {
        self.active.clear();
        self.best_by_car.clear();
        self.best_by_class.clear();
        self.prev_lap.clear();
        self.track_length_m = 0.0;
        self.points_count = 0;
        self.interval = 0.0;
    }

    /// Configure bucket count from track length (m). No-op when length unknown.
    pub fn configure(&mut self, track_length_m: Option<f32>) {
        let Some(len) = track_length_m.filter(|&l| l.is_finite() && l > 100.0) else {
            return;
        };
        if (self.track_length_m - len).abs() < 1.0 && self.points_count > 0 {
            return;
        }
        self.track_length_m = len;
        self.points_count = (len / TARGET_SPACING_M).ceil().max(10.0) as usize;
        self.interval = 1.0 / self.points_count as f32;
    }

    fn bucket_index(&self, pct: f32) -> usize {
        let idx = (pct * self.points_count as f32).floor() as usize;
        idx.min(self.points_count.saturating_sub(1))
    }

    /// Record one frame for a car. Call only when `points_count > 0`.
    pub fn collect(
        &mut self,
        car_idx: u32,
        lap: i32,
        lap_dist_pct: f32,
        session_time: f64,
        on_track: bool,
        on_pit: bool,
    ) {
        if self.points_count == 0 || !lap_dist_pct.is_finite() {
            return;
        }
        let pct = lap_dist_pct.clamp(0.0, 1.0);
        let idx = self.bucket_index(pct);
        let points_count = self.points_count;

        // Lap cross: finalize previous active lap.
        if let Some(&prev) = self.prev_lap.get(&car_idx) {
            if lap > prev {
                if let Some(finished) = self.active.remove(&car_idx) {
                    if finished.is_clean && finished.finish_time > finished.start_time {
                        let lap_time = (finished.finish_time - finished.start_time) as f32;
                        self.maybe_bank(car_idx, finished, lap_time);
                    }
                }
            }
        }
        self.prev_lap.insert(car_idx, lap);

        let clean = on_track && !on_pit;
        let lap_ref = self.active.entry(car_idx).or_insert_with(|| {
            let mut lap = ReferenceLap::empty();
            lap.points_count = self.points_count;
            lap.interval = self.interval;
            lap.point_pos = vec![-1.0; self.points_count];
            lap.times = vec![0.0; self.points_count];
            lap.start_time = session_time;
            lap.is_clean = clean;
            lap
        });

        if !clean {
            lap_ref.is_clean = false;
        }
        lap_ref.finish_time = session_time;

        // Only fill buckets we haven't seen yet this lap (forward progress).
        if lap_ref.point_pos[idx] < 0.0 {
            lap_ref.point_pos[idx] = pct;
            lap_ref.times[idx] = (session_time - lap_ref.start_time) as f32;
        } else if idx > 0 {
            let prev_marker = lap_ref.point_pos[idx];
            let prev_idx = (prev_marker * points_count as f32).floor() as usize;
            let prev_idx = prev_idx.min(points_count.saturating_sub(1));
            if idx > prev_idx {
                lap_ref.point_pos[idx] = pct;
                lap_ref.times[idx] = (session_time - lap_ref.start_time) as f32;
            }
        }
    }

    fn maybe_bank(&mut self, car_idx: u32, lap: ReferenceLap, lap_time: f32) {
        let replace = |existing: &ReferenceLap| {
            existing.finish_time <= existing.start_time
                || ((lap.finish_time - lap.start_time) as f32)
                    < ((existing.finish_time - existing.start_time) as f32)
        };
        if self.best_by_car.get(&car_idx).map_or(true, replace) {
            self.best_by_car.insert(car_idx, lap.clone());
        }
        let _ = lap_time;
    }

    pub fn bank_with_sectors(&mut self, car_idx: u32, class_id: Option<u32>, sectors: Sectors) {
        if let Some(mut lap) = self.active.remove(&car_idx) {
            if lap.is_clean && lap.finish_time > lap.start_time {
                lap.sector_times = sectors;
                let lap_time = (lap.finish_time - lap.start_time) as f32;
                self.maybe_bank(car_idx, lap.clone(), lap_time);
                if let Some(cid) = class_id {
                    let replace = |existing: &ReferenceLap| {
                        ((lap.finish_time - lap.start_time) as f32)
                            < ((existing.finish_time - existing.start_time) as f32)
                    };
                    if self.best_by_class.get(&cid).map_or(true, replace) {
                        self.best_by_class.insert(cid, lap);
                    }
                }
            }
        }
    }

    /// Best reference for gap math: car's own session best, else class best.
    pub fn reference_for(&self, car_idx: u32, class_id: Option<u32>) -> Option<&ReferenceLap> {
        self.best_by_car
            .get(&car_idx)
            .or_else(|| class_id.and_then(|c| self.best_by_class.get(&c)))
    }

    /// Ghost sector times from the player's best reference lap.
    pub fn ghost_sectors_for(&self, car_idx: u32, class_id: Option<u32>) -> Sectors {
        self.reference_for(car_idx, class_id)
            .map(|l| l.sector_times.clone())
            .unwrap_or_default()
    }
}

/// Linear interpolation of elapsed lap time at `track_pct` on a reference profile.
pub fn interpolate_at(lap: &ReferenceLap, track_pct: f32) -> Option<f32> {
    if lap.points_count == 0 || lap.point_pos.is_empty() {
        return None;
    }
    let pct = ((track_pct % 1.0) + 1.0) % 1.0;
    let n = lap.points_count;

    if pct <= lap.point_pos[0] {
        return Some(lap.times[0]);
    }
    if pct >= lap.point_pos[n - 1] {
        return Some(lap.times[n - 1]);
    }

    for i in 0..n - 1 {
        let p0 = lap.point_pos[i];
        let p1 = lap.point_pos[i + 1];
        if p0 < 0.0 || p1 < 0.0 {
            continue;
        }
        if p0 <= pct && pct <= p1 {
            if (p1 - p0).abs() < 1e-9 {
                return Some(lap.times[i]);
            }
            let frac = ((pct - p0) / (p1 - p0)).clamp(0.0, 1.0);
            return Some(lap.times[i] + frac * (lap.times[i + 1] - lap.times[i]));
        }
    }

    None
}

/// Signed time delta: positive = opponent ahead. Uses shortest track-time distance.
pub fn reference_delta(lap: &ReferenceLap, opponent_pct: f32, player_pct: f32) -> Option<f32> {
    let t_player = interpolate_at(lap, player_pct)?;
    let t_opponent = interpolate_at(lap, opponent_pct)?;
    let mut delta = t_opponent - t_player;
    let lap_time = (lap.finish_time - lap.start_time) as f32;
    if lap_time <= 0.0 {
        return Some(delta);
    }
    let pct_diff = opponent_pct - player_pct;
    if pct_diff <= -0.5 {
        delta += lap_time;
    } else if pct_diff >= 0.5 {
        delta -= lap_time;
    }
    Some(delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_lap() -> ReferenceLap {
        let n = 10;
        ReferenceLap {
            point_pos: (0..n).map(|i| i as f32 / n as f32).collect(),
            times: (0..n).map(|i| i as f32 * 10.0).collect(),
            interval: 1.0 / n as f32,
            points_count: n,
            start_time: 100.0,
            finish_time: 200.0,
            is_clean: true,
            sector_times: Sectors::default(),
        }
    }

    #[test]
    fn interpolate_midpoint() {
        let lap = sample_lap();
        let t = interpolate_at(&lap, 0.55).unwrap();
        assert!((t - 55.0).abs() < 2.0);
    }

    #[test]
    fn reference_delta_same_lap() {
        let lap = sample_lap();
        let d = reference_delta(&lap, 0.6, 0.5).unwrap();
        assert!((d - 10.0).abs() < 2.0);
    }
}
