//! Rolling per-car lap-time history for trend / average-lap columns.

use std::collections::HashMap;

const WINDOW: usize = 10;

#[derive(Default)]
pub struct LapHistoryStore {
    /// Last completed lap times per car (newest last).
    history: HashMap<u32, Vec<f32>>,
    prev_lap: HashMap<u32, i32>,
    prev_last_lap: HashMap<u32, f32>,
}

impl LapHistoryStore {
    pub fn reset(&mut self) {
        self.history.clear();
        self.prev_lap.clear();
        self.prev_last_lap.clear();
    }

    /// Feed one slow frame; records a lap when `CarIdxLap` increments or
    /// `CarIdxLastLapTime` changes after a lap cross.
    pub fn update(&mut self, car_idx: u32, lap: Option<i32>, last_lap_s: Option<f32>) {
        let Some(lap) = lap else {
            return;
        };
        let prev_lap = self.prev_lap.get(&car_idx).copied();
        let lap_crossed = prev_lap.map_or(false, |p| lap > p);

        if lap_crossed {
            if let Some(t) = self.prev_last_lap.get(&car_idx).copied().filter(|&t| t > 0.0) {
                self.push(car_idx, t);
            }
        }

        if let Some(t) = last_lap_s.filter(|&t| t.is_finite() && t > 0.0) {
            let prev = self.prev_last_lap.get(&car_idx).copied();
            // Also capture when last-lap time changes without lap increment (pit/out lap).
            if !lap_crossed {
                if prev.map_or(true, |p| (p - t).abs() > 0.05) {
                    self.push(car_idx, t);
                }
            }
            self.prev_last_lap.insert(car_idx, t);
        }
        self.prev_lap.insert(car_idx, lap);
    }

    fn push(&mut self, car_idx: u32, lap_s: f32) {
        let list = self.history.entry(car_idx).or_default();
        if list.last().map_or(true, |&l| (l - lap_s).abs() > 0.05) {
            list.push(lap_s);
            if list.len() > WINDOW {
                list.remove(0);
            }
        }
    }

    /// Median-filtered rolling average of recent laps.
    pub fn rolling_avg_s(&self, car_idx: u32) -> Option<f32> {
        let list = self.history.get(&car_idx)?;
        if list.is_empty() {
            return None;
        }
        let mut sorted: Vec<f32> = list.iter().copied().filter(|&t| t > 0.0).collect();
        if sorted.is_empty() {
            return None;
        }
        // Drop outliers beyond 1σ when we have enough samples.
        if sorted.len() >= 4 {
            let mean = sorted.iter().sum::<f32>() / sorted.len() as f32;
            let var = sorted.iter().map(|&t| (t - mean).powi(2)).sum::<f32>() / sorted.len() as f32;
            let sd = var.sqrt();
            if sd > 0.01 {
                sorted.retain(|&t| (t - mean).abs() <= sd);
            }
        }
        if sorted.is_empty() {
            return None;
        }
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(sorted[sorted.len() / 2])
    }

    /// Last lap minus rolling average (negative = faster than recent form).
    pub fn lap_delta_vs_avg_s(&self, car_idx: u32, last_lap_s: Option<f32>) -> Option<f32> {
        let last = last_lap_s.filter(|&t| t.is_finite() && t > 0.0)?;
        let avg = self.rolling_avg_s(car_idx)?;
        Some(last - avg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_median_basic() {
        let mut s = LapHistoryStore::default();
        for lap in 1..=5 {
            s.update(0, Some(lap), Some(90.0 + lap as f32));
        }
        let avg = s.rolling_avg_s(0).unwrap();
        assert!((avg - 93.0).abs() < 1.0);
    }
}
