//! Recording: tee normalized snapshots to a file as they flow through the
//! pipeline (dev-ergonomics §8).
//!
//! We record the *normalized* `TelemetrySnapshot` (JSON Lines), not raw
//! shared-memory bytes. That keeps fixtures sim-agnostic and replayable on any
//! OS — the goal is to develop widgets against real data off-Windows, and the
//! normalized snapshot is exactly what widgets consume. (Raw-byte capture would
//! tie fixtures to iRacing's exact memory layout and require the connector to
//! replay them.)

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::connector::{Capabilities, ConnectError, SimConnector};
use crate::snapshot::{SimId, TelemetrySnapshot};

/// Wraps any connector and appends each polled snapshot to a JSONL file.
pub struct RecordingConnector<C: SimConnector> {
    inner: C,
    writer: Option<BufWriter<File>>,
    count: u64,
    /// Minimum wall-clock gap between written frames; `None` records every poll.
    /// Lets a long capture stay small enough to replay (the replay loader reads
    /// the whole file into memory).
    min_interval: Option<Duration>,
    last_write: Option<Instant>,
}

impl<C: SimConnector> RecordingConnector<C> {
    /// Create a recorder writing to `path` (overwrites). The file is written
    /// lazily-flushed per frame so a kill mid-session still yields a usable file.
    pub fn new(inner: C, path: impl AsRef<Path>) -> std::io::Result<Self> {
        Self::with_max_hz(inner, path, None)
    }

    /// Like [`new`](Self::new) but caps the recorded rate to `max_hz` (skipping
    /// frames that arrive sooner than `1/max_hz`). `None` records every poll.
    pub fn with_max_hz(
        inner: C,
        path: impl AsRef<Path>,
        max_hz: Option<f64>,
    ) -> std::io::Result<Self> {
        let file = File::create(path)?;
        let min_interval = max_hz
            .filter(|hz| *hz > 0.0)
            .map(|hz| Duration::from_secs_f64(1.0 / hz));
        Ok(Self {
            inner,
            writer: Some(BufWriter::new(file)),
            count: 0,
            min_interval,
            last_write: None,
        })
    }

    pub fn recorded(&self) -> u64 {
        self.count
    }
}

impl<C: SimConnector> SimConnector for RecordingConnector<C> {
    fn sim_id(&self) -> SimId {
        self.inner.sim_id()
    }
    fn connect(&mut self) -> Result<(), ConnectError> {
        self.inner.connect()
    }
    fn is_connected(&self) -> bool {
        self.inner.is_connected()
    }
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }
    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        let snap = self.inner.poll()?;
        // Rate-cap: skip writing (but still pass the frame through) when the last
        // write was more recent than `min_interval`.
        if let Some(min) = self.min_interval {
            let now = Instant::now();
            match self.last_write {
                Some(prev) if now.duration_since(prev) < min => return Some(snap),
                _ => self.last_write = Some(now),
            }
        }
        if let Some(w) = self.writer.as_mut() {
            if let Ok(line) = serde_json::to_string(&snap) {
                // Best-effort; a write error just stops recording.
                if writeln!(w, "{line}").and_then(|_| w.flush()).is_err() {
                    self.writer = None;
                } else {
                    self.count += 1;
                }
            }
        }
        Some(snap)
    }
}
