//! The reader loop + fan-out.
//!
//! This is perf non-negotiable #1 in code form: a single thread owns the sim
//! connection, polls it at the sim's rate, stamps each frame, and pushes
//! snapshots out over a channel. Consumers (the CLI now; the Tauri webview
//! later) render at their own capped rate — reading is decoupled from rendering.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::connector::{ConnectError, SimConnector};
use crate::snapshot::TelemetrySnapshot;

/// Owns the reader thread and the receiving end of the snapshot stream.
///
/// Dropping the handle stops the thread (and joins it).
pub struct ReaderHandle {
    rx: Receiver<TelemetrySnapshot>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl ReaderHandle {
    /// The stream of normalized snapshots. For Phase 1 this is unbounded; the
    /// shared-memory/IPC bridge in later phases adds per-widget throttling.
    pub fn snapshots(&self) -> &Receiver<TelemetrySnapshot> {
        &self.rx
    }

    /// Signal the reader thread to stop (idempotent). Drop also does this.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for ReaderHandle {
    fn drop(&mut self) {
        self.stop();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// Spawn a reader thread driving `connector`.
///
/// The thread:
/// 1. retries `connect()` until it succeeds (or stop is requested),
/// 2. loops `poll()`, stamping `meta.tick` / `meta.frame_timestamp_s`,
/// 3. forwards each fresh snapshot,
/// 4. re-connects if the connection drops.
pub fn spawn_reader<C>(mut connector: C) -> ReaderHandle
where
    C: SimConnector + 'static,
{
    let (tx, rx) = mpsc::channel::<TelemetrySnapshot>();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);

    let join = thread::Builder::new()
        .name("telemetry-reader".into())
        .spawn(move || {
            let started = Instant::now();
            let mut tick: u64 = 0;

            while !stop_thread.load(Ordering::Relaxed) {
                if !connector.is_connected() {
                    match connector.connect() {
                        Ok(()) => {}
                        Err(ConnectError::Unsupported) => {
                            // No point retrying on this platform/source.
                            break;
                        }
                        Err(_) => {
                            // Sim not running yet, etc. Back off and retry.
                            sleep_interruptible(&stop_thread, Duration::from_millis(500));
                            continue;
                        }
                    }
                }

                match connector.poll() {
                    Some(mut snap) => {
                        tick = tick.wrapping_add(1);
                        snap.meta.tick = tick;
                        snap.meta.frame_timestamp_s = started.elapsed().as_secs_f64();
                        // If the consumer has hung up, the reader is done.
                        if tx.send(snap).is_err() {
                            break;
                        }
                    }
                    None => {
                        // Timeout / no new frame. `poll()` already blocked on the
                        // sim's data-ready signal, so we don't add a sleep here
                        // (that would just add latency). The loop re-checks stop.
                    }
                }
            }
        })
        .expect("failed to spawn telemetry-reader thread");

    ReaderHandle {
        rx,
        stop,
        join: Some(join),
    }
}

/// Sleep that wakes early if a stop has been requested, so shutdown stays snappy.
fn sleep_interruptible(stop: &AtomicBool, total: Duration) {
    let step = Duration::from_millis(50);
    let mut slept = Duration::ZERO;
    while slept < total {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        thread::sleep(step.min(total - slept));
        slept += step;
    }
}
