//! Phase 1 dev harness.
//!
//! Selects a telemetry source (live iRacing / mock), runs it through the shared
//! reader loop, and prints the normalized snapshots — proving the hot path and
//! letting us eyeball the snapshot shape. No UI yet (that's Phase 2).
//!
//! Usage:
//!   overlay-cli [--source auto|mock|iracing] [--duration SECONDS] [--print-hz HZ]
//!
//! The reader runs at the source's full rate; the printer is throttled (default
//! 5 Hz) so the console stays readable — a tiny demonstration of decoupling
//! reading from rendering.

use std::time::{Duration, Instant};

use overlay_core::{
    spawn_reader, MockConnector, RecordingConnector, ReplayConnector, SimConnector,
    TelemetrySnapshot,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Auto,
    Mock,
    IRacing,
    Lmu,
    Replay,
}

struct Args {
    source: Source,
    duration: Option<Duration>,
    print_hz: f64,
    /// Record every emitted snapshot to this JSONL file.
    record: Option<String>,
    /// Cap the recorded rate (Hz); `None` records every frame (~60 Hz).
    record_hz: Option<f64>,
    /// Replay file (used when source = replay).
    replay: Option<String>,
}

fn parse_args() -> Args {
    let mut source = Source::Auto;
    let mut duration = None;
    let mut print_hz = 5.0;
    let mut record = None;
    let mut record_hz = None;
    let mut replay = None;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--source" => {
                source = match it.next().as_deref() {
                    Some("mock") => Source::Mock,
                    Some("iracing") => Source::IRacing,
                    Some("lmu") => Source::Lmu,
                    Some("replay") => Source::Replay,
                    Some("auto") | None => Source::Auto,
                    Some(other) => {
                        eprintln!("unknown --source '{other}', using auto");
                        Source::Auto
                    }
                };
            }
            "--record" => record = it.next(),
            "--record-hz" => record_hz = it.next().and_then(|s| s.parse::<f64>().ok()),
            "--replay" => replay = it.next(),
            "--duration" => {
                duration = it
                    .next()
                    .and_then(|s| s.parse::<f64>().ok())
                    .map(Duration::from_secs_f64);
            }
            "--print-hz" => {
                if let Some(hz) = it.next().and_then(|s| s.parse::<f64>().ok()) {
                    print_hz = hz.max(0.1);
                }
            }
            "-h" | "--help" => {
                println!(
                    "overlay-cli [--source auto|mock|iracing|lmu|replay] [--replay FILE] \
                     [--record FILE] [--record-hz HZ] [--duration SECONDS] [--print-hz HZ]"
                );
                std::process::exit(0);
            }
            other => eprintln!("ignoring unknown arg '{other}'"),
        }
    }

    Args {
        source,
        duration,
        print_hz,
        record,
        record_hz,
        replay,
    }
}

/// Auto-detecting source: probes each supported sim's connector in priority
/// order and adopts the first whose shared memory is present, re-probing (via
/// the reader's retry loop) whenever nothing is connected. Mirrors the app's
/// `AutoConnector` in `src-tauri/src/main.rs` — the probe is opening the mapping,
/// which only succeeds when a sim is running and publishing telemetry.
#[cfg(windows)]
struct AutoConnector {
    active: Option<Box<dyn SimConnector>>,
}

#[cfg(windows)]
impl AutoConnector {
    fn new() -> Self {
        Self { active: None }
    }

    fn candidates() -> Vec<Box<dyn SimConnector>> {
        use iracing_connector::IRacingConnector;
        use lmu_connector::LmuConnector;
        vec![
            Box::new(IRacingConnector::new()),
            Box::new(LmuConnector::new()),
        ]
    }
}

#[cfg(windows)]
impl SimConnector for AutoConnector {
    fn sim_id(&self) -> overlay_core::SimId {
        self.active
            .as_ref()
            .map_or(overlay_core::SimId::Unknown, |c| c.sim_id())
    }

    fn connect(&mut self) -> Result<(), overlay_core::ConnectError> {
        for mut cand in Self::candidates() {
            if cand.connect().is_ok() {
                self.active = Some(cand);
                return Ok(());
            }
        }
        Err(overlay_core::ConnectError::NotRunning)
    }

    fn is_connected(&self) -> bool {
        self.active.as_ref().is_some_and(|c| c.is_connected())
    }

    fn capabilities(&self) -> overlay_core::Capabilities {
        self.active
            .as_ref()
            .map_or_else(overlay_core::Capabilities::default, |c| c.capabilities())
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        let snap = self.active.as_mut()?.poll();
        if self.active.as_ref().is_some_and(|c| !c.is_connected()) {
            self.active = None;
        }
        snap
    }
}

/// Build the underlying source connector.
fn build_source(source: Source, replay: Option<String>) -> Box<dyn SimConnector> {
    if source == Source::Replay {
        let path = replay.unwrap_or_else(|| "fixtures/session.jsonl".into());
        return Box::new(ReplayConnector::new(path));
    }
    #[cfg(windows)]
    {
        use iracing_connector::IRacingConnector;
        use lmu_connector::LmuConnector;
        match source {
            Source::Mock => Box::new(MockConnector::new()),
            Source::IRacing => Box::new(IRacingConnector::new()),
            Source::Lmu => Box::new(LmuConnector::new()),
            // Auto detects whichever sim is running (Replay handled above).
            _ => Box::new(AutoConnector::new()),
        }
    }
    #[cfg(not(windows))]
    {
        if matches!(source, Source::IRacing | Source::Lmu) {
            eprintln!("live sims are Windows-only; falling back to the mock source.");
        }
        Box::new(MockConnector::new())
    }
}

/// Build the requested connector, optionally wrapped in a recorder.
fn build_connector(args: &Args) -> Box<dyn SimConnector> {
    let source = build_source(args.source, args.replay.clone());
    match &args.record {
        Some(path) => {
            match args.record_hz {
                Some(hz) => println!("recording snapshots to {path} (capped at {hz} Hz)"),
                None => println!("recording snapshots to {path} (full rate)"),
            }
            Box::new(
                RecordingConnector::with_max_hz(source, path, args.record_hz).unwrap_or_else(|e| {
                    eprintln!("cannot record to {path}: {e}");
                    std::process::exit(1);
                }),
            )
        }
        None => source,
    }
}

fn fmt_opt<T: std::fmt::Display>(v: Option<T>, width: usize) -> String {
    match v {
        Some(x) => format!("{x:>width$}"),
        None => format!("{:>width$}", "--"),
    }
}

fn print_snapshot(snap: &TelemetrySnapshot, reader_hz: f64) {
    let p = &snap.player;
    let speed_kmh = p.speed_ms.map(|s| s * 3.6);
    let dpct = p.lap_dist_pct.map(|x| x * 100.0);

    println!(
        "[{:?}] t={:>6.2}s reader={:>5.1}Hz tick={:<6} | gear {} spd {}km/h rpm {} | thr {} brk {} clu {} str {}rad | lap {} dpct {}% Δbest {}s | last {}s best {}s | {}",
        snap.meta.sim,
        snap.meta.frame_timestamp_s,
        reader_hz,
        snap.meta.tick,
        fmt_opt(p.gear, 2),
        fmt_opt(speed_kmh.map(|v| format!("{v:6.1}")), 6),
        fmt_opt(p.rpm.map(|v| format!("{v:5.0}")), 5),
        fmt_opt(p.throttle.map(|v| format!("{v:.2}")), 4),
        fmt_opt(p.brake.map(|v| format!("{v:.2}")), 4),
        fmt_opt(p.clutch.map(|v| format!("{v:.2}")), 4),
        fmt_opt(p.steering_rad.map(|v| format!("{v:+.2}")), 5),
        fmt_opt(p.lap, 3),
        fmt_opt(dpct.map(|v| format!("{v:5.1}")), 5),
        fmt_opt(p.delta_best_s.map(|v| format!("{v:+.2}")), 5),
        fmt_opt(p.last_lap_s.map(|v| format!("{v:.2}")), 6),
        fmt_opt(p.best_lap_s.map(|v| format!("{v:.2}")), 6),
        snap.session.track_name.as_deref().unwrap_or("(no track)"),
    );
}

fn main() {
    let args = parse_args();
    let connector = build_connector(&args);

    println!(
        "overlay-cli: source={:?} sim={:?} caps={:?}",
        args.source,
        connector.sim_id(),
        connector.capabilities()
    );
    if matches!(args.source, Source::Auto | Source::IRacing) {
        println!("(waiting for telemetry — if iRacing isn't running, try --source mock)");
    }
    if args.source == Source::Lmu {
        println!(
            "(waiting for LMU telemetry — needs Le Mans Ultimate running with the rF2 \
             Shared Memory Map Plugin installed. Set OVERLAY_DUMP_RF2=1 for a calibration dump.)"
        );
    }

    let reader = spawn_reader(connector);
    let rx = reader.snapshots();

    let start = Instant::now();
    let print_interval = Duration::from_secs_f64(1.0 / args.print_hz);

    let mut last_print = Instant::now();
    let mut frames_since_print: u64 = 0;
    let mut measured_hz = 0.0;

    loop {
        if let Some(dur) = args.duration {
            if start.elapsed() >= dur {
                break;
            }
        }

        // Block for the next snapshot (with a timeout so duration/Ctrl-C are honored).
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(snap) => {
                frames_since_print += 1;

                if last_print.elapsed() >= print_interval {
                    let secs = last_print.elapsed().as_secs_f64();
                    if secs > 0.0 {
                        measured_hz = frames_since_print as f64 / secs;
                    }
                    print_snapshot(&snap, measured_hz);
                    frames_since_print = 0;
                    last_print = Instant::now();
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // No data yet (sim not running, or between frames). Keep waiting.
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("reader stopped.");
                break;
            }
        }
    }
}
