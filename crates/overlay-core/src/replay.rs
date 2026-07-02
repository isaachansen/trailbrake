//! Replay: feed recorded snapshots back through the normal pipeline at their
//! original cadence, so widgets can be developed/tested against real captured
//! data on any OS (dev-ergonomics §8). Loops when it reaches the end.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::connector::{Capabilities, ConnectError, SimConnector};
use crate::snapshot::{SimId, TelemetrySnapshot};

pub struct ReplayConnector {
    path: PathBuf,
    frames: Vec<TelemetrySnapshot>,
    idx: usize,
    connected: bool,
    /// Recorded timestamp of the previously emitted frame, for pacing.
    last_ts: Option<f64>,
}

impl ReplayConnector {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            frames: Vec::new(),
            idx: 0,
            connected: false,
            last_ts: None,
        }
    }
}

impl SimConnector for ReplayConnector {
    fn sim_id(&self) -> SimId {
        self.frames
            .first()
            .map(|f| f.meta.sim)
            .unwrap_or(SimId::Unknown)
    }

    fn connect(&mut self) -> Result<(), ConnectError> {
        let text = std::fs::read_to_string(&self.path)
            .map_err(|e| ConnectError::Os(format!("replay open {:?}: {e}", self.path)))?;
        let mut frames = Vec::new();
        let mut bad = 0usize;
        let mut first_err: Option<(usize, String)> = None;
        for (i, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<TelemetrySnapshot>(line) {
                Ok(snap) => frames.push(snap),
                Err(e) => {
                    bad += 1;
                    first_err.get_or_insert((i + 1, e.to_string()));
                }
            }
        }
        if bad > 0 {
            // Don't swallow a broken fixture: say what was skipped and where.
            let (line, err) = first_err.as_ref().expect("bad > 0 implies a first error");
            eprintln!(
                "replay {:?}: skipped {bad} malformed line(s); first at line {line}: {err}",
                self.path
            );
        }
        if frames.is_empty() {
            // An all-malformed file is a broken fixture, not "sim not running".
            if let Some((line, err)) = first_err {
                return Err(ConnectError::Os(format!(
                    "replay {:?}: all {bad} line(s) malformed; first at line {line}: {err}",
                    self.path
                )));
            }
            return Err(ConnectError::NotRunning);
        }
        self.frames = frames;
        self.idx = 0;
        self.last_ts = None;
        self.connected = true;
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected && !self.frames.is_empty()
    }

    fn capabilities(&self) -> Capabilities {
        // Permissive: the recorded data itself dictates which fields are present;
        // widgets hide what's missing per-field.
        Capabilities {
            clutch: true,
            steering_angle: true,
            fuel: true,
            deltas: true,
            relative_gaps: true,
            irating: true,
            safety_rating: true,
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
        if self.frames.is_empty() {
            return None;
        }
        let snap = self.frames[self.idx].clone();
        let ts = snap.meta.frame_timestamp_s;

        // Pace to the original cadence (clamp to sane bounds; ignore wrap).
        if let Some(prev) = self.last_ts {
            let dt = ts - prev;
            if dt > 0.0 && dt < 1.0 {
                std::thread::sleep(Duration::from_secs_f64(dt));
            } else {
                std::thread::sleep(Duration::from_millis(16));
            }
        }
        self.last_ts = Some(ts);

        self.idx += 1;
        if self.idx >= self.frames.len() {
            self.idx = 0;
            self.last_ts = None; // avoid a negative/huge sleep on loop
        }
        Some(snap)
    }
}
