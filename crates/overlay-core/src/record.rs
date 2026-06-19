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

use crate::connector::{Capabilities, ConnectError, SimConnector};
use crate::snapshot::{SimId, TelemetrySnapshot};

/// Wraps any connector and appends each polled snapshot to a JSONL file.
pub struct RecordingConnector<C: SimConnector> {
    inner: C,
    writer: Option<BufWriter<File>>,
    count: u64,
}

impl<C: SimConnector> RecordingConnector<C> {
    /// Create a recorder writing to `path` (overwrites). The file is written
    /// lazily-flushed per frame so a kill mid-session still yields a usable file.
    pub fn new(inner: C, path: impl AsRef<Path>) -> std::io::Result<Self> {
        let file = File::create(path)?;
        Ok(Self {
            inner,
            writer: Some(BufWriter::new(file)),
            count: 0,
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
