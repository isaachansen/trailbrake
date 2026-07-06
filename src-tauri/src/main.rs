// Tauri shell for Sim Overlay.
//
// Two windows, one webview bundle (routed by window label in the frontend):
//   - "manager": a normal decorated control UI (pick widgets, customize, set
//     hotkeys, manage profiles). Opens on launch; closing it hides to the tray
//     instead of quitting.
//   - "overlay": the transparent, borderless, always-on-top, click-through
//     surface the widgets composite onto the game. Hidden until it's needed.
//
// Overlay visibility is reconciled from four inputs (see `reconcile_overlay`):
//   visible   = editing || preview || (auto_show && session_active) || vr_active
//   interactive (cursor captured) = editing
// A session watchdog on the telemetry bridge flips `session_active` when frames
// start/stop flowing, so the overlay auto-shows in a session and hides when it
// ends. The edit-mode global hotkey is user-configurable and re-registered live.
//
// The Rust side owns the sim connection (overlay-core's reader) and fans
// snapshots out to the webview as throttled fast/slow events. Widgets never
// touch the sim. (§3: decouple read from render, centralize, fast vs slow.)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod lmu_plugin;
mod track_maps;
mod vr;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use overlay_core::{
    spawn_reader, Capabilities, FlagState, MockConnector, ReplayConnector, SimConnector,
    TelemetrySnapshot,
};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

// Event channel names — must match the frontend transport.
const EVT_FAST: &str = "telemetry://fast";
const EVT_SLOW: &str = "telemetry://slow";
const EVT_CAPS: &str = "telemetry://caps";
const EVT_EDIT_MODE: &str = "overlay://edit-mode";
const EVT_STATUS: &str = "overlay://status";

/// Cap on how often EVT_FAST is emitted to the webviews. LMU's rF2 physics
/// reader runs ~90-100 Hz, vs iRacing's ~60 Hz — every reader frame was being
/// forwarded as its own IPC message + JSON serialize, so LMU was paying
/// ~50% more fast-path IPC/CPU than iRacing for no visible benefit (the
/// rAF-driven fast widgets already cap their read rate at the display
/// refresh rate). We throttle by *dropping* intermediate frames rather than
/// queuing/delaying them, so the emitted payload is always the newest
/// sample and the added worst-case latency is bounded by this interval. On
/// iRacing (already ~60 Hz) this is a no-op.
const FAST_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(16);

/// Default edit-mode hotkey if the user hasn't set one. `CmdOrCtrl` maps to
/// Ctrl on Windows/Linux and Cmd on macOS.
const DEFAULT_EDIT_HOTKEY: &str = "CmdOrCtrl+Shift+O";

/// If no telemetry frame arrives for this long, the session is considered over
/// and the overlay auto-hides.
const SESSION_TIMEOUT: Duration = Duration::from_millis(1500);

/// Reconcilable overlay/session state, shared between the bridge thread, the
/// hotkey handler, the tray, and the manager-driven commands.
struct OverlayState {
    /// Edit mode: overlay is shown and captures the cursor (drag/resize).
    edit: AtomicBool,
    /// Manual "keep the overlay on screen" flag (so widgets stay visible after
    /// you exit edit mode while configuring). Cleared when a session ends.
    preview: AtomicBool,
    /// Telemetry is currently flowing (we're in a session).
    session_active: AtomicBool,
    /// Whether to auto-show the overlay when a session starts.
    auto_show: AtomicBool,
    /// VR compositor is running: force the overlay window shown so Windows
    /// Graphics Capture has a rendered surface to read.
    vr_active: AtomicBool,
    /// The selected telemetry source label, for the manager status line.
    source: Mutex<String>,
    /// The currently-registered edit-mode hotkey, so we can unregister it on change.
    edit_hotkey: Mutex<Shortcut>,
    /// Whether the launch-time "show the manager window?" decision has been made.
    /// Set true by the first telemetry frame (we started mid-session → stay in the
    /// tray) or by the startup grace timer (no session → show the manager). Ensures
    /// a mid-race restart never pops the control window over the game.
    launch_manager_resolved: AtomicBool,
    /// Serializes `reconcile_overlay`'s read→apply so concurrent callers (bridge
    /// watchdog, hotkey, manager commands) can't interleave a stale show/hide
    /// over a fresh one.
    reconcile: Mutex<()>,
    /// Click-through hit-testing while editing (issue 4b): the overlay window
    /// ignores cursor events by default even in edit mode, and the cursor-poll
    /// thread (`spawn_cursor_poll`) flips capture on only while the OS cursor is
    /// over one of these logical, window-relative rects — reported live by the
    /// frontend (`src/store/hitRegions.ts`) for every element that opts into
    /// native capture. Empty/ignored whenever we're not editing.
    hit_regions: Mutex<Vec<HitRect>>,
    /// True while a pointer gesture (drag/resize) is in progress in the webview.
    /// Forces full cursor capture regardless of hover position, so a drag that
    /// carries the cursor outside the widget's original rect (via
    /// `setPointerCapture`) never gets stranded by the window suddenly ignoring
    /// cursor events mid-gesture.
    force_capture: AtomicBool,
}

/// A logical, window-relative rectangle reported by the frontend for hit-testing
/// clicks while editing (issue 4b). Coordinates are CSS pixels in the overlay
/// window's own viewport (`.overlay-root` exactly coincides with it).
#[derive(Clone, Copy, Deserialize)]
struct HitRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl HitRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

impl OverlayState {
    /// The single source of truth for overlay visibility — must match what
    /// `reconcile_overlay` applies to the native window.
    fn overlay_visible(&self) -> bool {
        self.edit.load(Ordering::SeqCst)
            || self.preview.load(Ordering::SeqCst)
            || (self.auto_show.load(Ordering::SeqCst) && self.session_active.load(Ordering::SeqCst))
            // VR keeps the overlay window rendered (off in the headset, but capturable).
            || self.vr_active.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusMsg {
    session_active: bool,
    editing: bool,
    preview: bool,
    overlay_visible: bool,
    source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfo {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    is_primary: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FastSample {
    ts: f64,
    tick: u64,
    reader_hz: f32,
    speed_ms: Option<f32>,
    rpm: Option<f32>,
    gear: Option<i32>,
    throttle: Option<f32>,
    brake: Option<f32>,
    clutch: Option<f32>,
    steering_rad: Option<f32>,
    lap_dist_pct: Option<f32>,
    /// Current lap time (seconds), for the Lap Timer widget.
    current_lap_s: Option<f32>,
    /// Brake bias fraction 0..1 (front bias).
    brake_bias_pct: Option<f32>,
    /// ABS active this frame.
    abs_active: Option<bool>,
    /// TC active this frame.
    tc_active: Option<bool>,
    /// Spotter: a car is alongside on the left (iRacing `CarLeftRight`).
    car_left: Option<bool>,
    /// Spotter: a car is alongside on the right (iRacing `CarLeftRight`).
    car_right: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CarMsg {
    car_idx: u32,
    driver_name: Option<String>,
    car_screen_name: Option<String>,
    car_class_id: Option<u32>,
    car_class_name: Option<String>,
    class_color: Option<u32>,
    car_number: Option<String>,
    country: Option<String>,
    positions_gained: Option<i32>,
    irating_delta: Option<i32>,
    tyre: Option<String>,
    position: Option<u32>,
    class_position: Option<u32>,
    lap: Option<i32>,
    lap_dist_pct: Option<f32>,
    gap_to_player_s: Option<f32>,
    last_lap_s: Option<f32>,
    best_lap_s: Option<f32>,
    on_pit_road: Option<bool>,
    /// Whether the car is loaded into the world (on track / pits / off-track) vs.
    /// not present (garage / disconnected). The Relative widget hides cars that
    /// are not in the world so stale roster entries don't appear as phantom
    /// neighbours. Must be forwarded here or the frontend filter sees `undefined`.
    in_world: Option<bool>,
    irating: Option<i32>,
    safety_rating: Option<String>,
    rel_lat_m: Option<f32>,
    rel_lon_m: Option<f32>,
    /// Pit-stop status (sim-specific enum).
    pit_status: Option<u32>,
    /// True when this car holds the session fastest lap.
    has_session_fastest: Option<bool>,
    is_player: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlowSample {
    sim: String,
    track_name: Option<String>,
    session_type: Option<String>,
    time_remaining_s: Option<f64>,
    laps_remaining: Option<i32>,
    total_cars: Option<u32>,
    lap: Option<i32>,
    position: Option<u32>,
    class_position: Option<u32>,
    last_lap_s: Option<f32>,
    best_lap_s: Option<f32>,
    current_lap_s: Option<f32>,
    delta_best_s: Option<f32>,
    delta_session_best_s: Option<f32>,
    fuel_l: Option<f32>,
    fuel_per_lap_l: Option<f32>,
    cars: Vec<CarMsg>,
    player_car_idx: Option<u32>,
    spectated_car_idx: Option<u32>,
    car_name: Option<String>,
    on_track: Option<bool>,
    in_garage: Option<bool>,
    car_left: Option<bool>,
    car_right: Option<bool>,
    track_path: Option<Vec<[f32; 2]>>,
    track_turns: Option<Vec<overlay_core::TrackTurn>>,
    track_metadata: Option<overlay_core::TrackMetadata>,
    // Weather.
    flags_raw: Option<u32>,
    /// Sim-neutral decoded flag state (e.g. `"green"`, `"yellow"`, `"none"`).
    /// Serialized as the `FlagState` enum's snake_case serde name.
    flag: String,
    air_temp_c: Option<f32>,
    track_temp_c: Option<f32>,
    wind_speed_ms: Option<f32>,
    wind_dir_rad: Option<f32>,
    track_wetness_pct: Option<f32>,
    precipitation_pct: Option<f32>,
    humidity_pct: Option<f32>,
    // Race control + chat feeds.
    messages: Vec<RaceControlMsg>,
    chat_messages: Vec<ChatMsg>,
    // Pit info.
    pit_speed_limit_ms: Option<f32>,
    pit_box_dist_m: Option<f32>,
    // Sector times.
    sector_times_s: SectorsMsg,
    sector_best_s: SectorsMsg,
    // In-car setup.
    brake_bias_pct: Option<f32>,
    abs_active: Option<bool>,
    tc_active: Option<bool>,
    drs_state: Option<i32>,
    ers_pct: Option<f32>,
    fuel_mix: Option<i32>,
    p2p_available: Option<i32>,
    tire_pressures: TirePressuresMsg,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RaceControlMsg {
    time_s: Option<f64>,
    kind: String,
    text: String,
    priority: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMsg {
    user: String,
    color: Option<String>,
    badge: Option<String>,
    text: String,
    time_s: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SectorsMsg {
    s1: Option<f32>,
    s2: Option<f32>,
    s3: Option<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TirePressuresMsg {
    lf_kpa: Option<f32>,
    rf_kpa: Option<f32>,
    lr_kpa: Option<f32>,
    rr_kpa: Option<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapsMsg {
    clutch: bool,
    steering_angle: bool,
    fuel: bool,
    deltas: bool,
    relative_gaps: bool,
    irating: bool,
    safety_rating: bool,
    multiclass: bool,
    proximity: bool,
    track_map: bool,
    race_control: bool,
    chat: bool,
    weather: bool,
    sectors: bool,
    car_setup: bool,
    spectator: bool,
    pit_info: bool,
}

impl From<Capabilities> for CapsMsg {
    fn from(c: Capabilities) -> Self {
        CapsMsg {
            clutch: c.clutch,
            steering_angle: c.steering_angle,
            fuel: c.fuel,
            deltas: c.deltas,
            relative_gaps: c.relative_gaps,
            irating: c.irating,
            safety_rating: c.safety_rating,
            multiclass: c.multiclass,
            proximity: c.proximity,
            track_map: c.track_map,
            race_control: c.race_control,
            chat: c.chat,
            weather: c.weather,
            sectors: c.sectors,
            car_setup: c.car_setup,
            spectator: c.spectator,
            pit_info: c.pit_info,
        }
    }
}

fn fast_from(snap: &TelemetrySnapshot, reader_hz: f32) -> FastSample {
    let p = &snap.player;
    FastSample {
        ts: snap.meta.frame_timestamp_s,
        tick: snap.meta.tick,
        reader_hz,
        speed_ms: p.speed_ms,
        rpm: p.rpm,
        gear: p.gear,
        throttle: p.throttle,
        brake: p.brake,
        clutch: p.clutch,
        steering_rad: p.steering_rad,
        lap_dist_pct: p.lap_dist_pct,
        current_lap_s: p.current_lap_s,
        brake_bias_pct: p.brake_bias_pct,
        abs_active: p.abs_active,
        tc_active: p.tc_active,
        car_left: p.car_left,
        car_right: p.car_right,
    }
}

/// The `FlagState` enum's serde (snake_case) name, matching what
/// `#[derive(Serialize)] #[serde(rename_all = "snake_case")]` would emit —
/// spelled out here so `SlowSample.flag` is a plain string in the webview
/// payload instead of a nested JSON value.
fn flag_state_str(flag: FlagState) -> &'static str {
    match flag {
        FlagState::None => "none",
        FlagState::Green => "green",
        FlagState::Yellow => "yellow",
        FlagState::Blue => "blue",
        FlagState::White => "white",
        FlagState::Red => "red",
        FlagState::Checkered => "checkered",
        FlagState::Black => "black",
        FlagState::Debris => "debris",
    }
}

fn slow_from(snap: &TelemetrySnapshot) -> SlowSample {
    let p = &snap.player;
    let s = &snap.session;
    let player_idx = p.car_idx;
    let cars = snap
        .cars
        .iter()
        .map(|c| CarMsg {
            car_idx: c.car_idx,
            driver_name: c.driver_name.clone(),
            car_screen_name: c.car_screen_name.clone(),
            car_class_id: c.car_class_id,
            car_class_name: c.car_class_name.clone(),
            class_color: c.class_color,
            car_number: c.car_number.clone(),
            country: c.country.clone(),
            positions_gained: c.positions_gained,
            irating_delta: c.irating_delta,
            tyre: c.tyre.clone(),
            position: c.position,
            class_position: c.class_position,
            lap: c.lap,
            lap_dist_pct: c.lap_dist_pct,
            gap_to_player_s: c.gap_to_player_s,
            last_lap_s: c.last_lap_s,
            best_lap_s: c.best_lap_s,
            on_pit_road: c.on_pit_road,
            in_world: c.in_world,
            irating: c.irating,
            safety_rating: c.safety_rating.clone(),
            rel_lat_m: c.rel_lat_m,
            rel_lon_m: c.rel_lon_m,
            pit_status: c.pit_status,
            has_session_fastest: c.has_session_fastest,
            is_player: player_idx == Some(c.car_idx),
        })
        .collect();
    SlowSample {
        sim: format!("{:?}", snap.meta.sim).to_lowercase(),
        track_name: s.track_name.clone(),
        session_type: s.session_type.clone(),
        time_remaining_s: s.time_remaining_s,
        laps_remaining: s.laps_remaining,
        total_cars: s.total_cars,
        lap: p.lap,
        position: p.position,
        class_position: p.class_position,
        last_lap_s: p.last_lap_s,
        best_lap_s: p.best_lap_s,
        current_lap_s: p.current_lap_s,
        delta_best_s: p.delta_best_s,
        delta_session_best_s: p.delta_session_best_s,
        fuel_l: p.fuel_l,
        fuel_per_lap_l: p.fuel_per_lap_l,
        cars,
        player_car_idx: player_idx,
        spectated_car_idx: s.spectated_car_idx,
        car_name: p.car_name.clone(),
        on_track: p.on_track,
        in_garage: p.in_garage,
        car_left: p.car_left,
        car_right: p.car_right,
        track_path: s.track_path.clone(),
        track_turns: s.track_turns.clone(),
        track_metadata: s.track_metadata.clone(),
        flags_raw: s.flags_raw,
        flag: flag_state_str(s.flag).to_string(),
        air_temp_c: s.air_temp_c,
        track_temp_c: s.track_temp_c,
        wind_speed_ms: s.wind_speed_ms,
        wind_dir_rad: s.wind_dir_rad,
        track_wetness_pct: s.track_wetness_pct,
        precipitation_pct: s.precipitation_pct,
        humidity_pct: s.humidity_pct,
        messages: s
            .messages
            .iter()
            .map(|m| RaceControlMsg {
                time_s: m.time_s,
                kind: m.kind.clone(),
                text: m.text.clone(),
                priority: m.priority,
            })
            .collect(),
        chat_messages: s
            .chat_messages
            .iter()
            .map(|m| ChatMsg {
                user: m.user.clone(),
                color: m.color.clone(),
                badge: m.badge.clone(),
                text: m.text.clone(),
                time_s: m.time_s,
            })
            .collect(),
        pit_speed_limit_ms: p.pit_speed_limit_ms,
        pit_box_dist_m: p.pit_box_dist_m,
        sector_times_s: SectorsMsg {
            s1: p.sector_times_s.s1,
            s2: p.sector_times_s.s2,
            s3: p.sector_times_s.s3,
        },
        sector_best_s: SectorsMsg {
            s1: p.sector_best_s.s1,
            s2: p.sector_best_s.s2,
            s3: p.sector_best_s.s3,
        },
        brake_bias_pct: p.brake_bias_pct,
        abs_active: p.abs_active,
        tc_active: p.tc_active,
        drs_state: p.drs_state,
        ers_pct: p.ers_pct,
        fuel_mix: p.fuel_mix,
        p2p_available: p.p2p_available,
        tire_pressures: TirePressuresMsg {
            lf_kpa: p.tire_pressures.lf_kpa,
            rf_kpa: p.tire_pressures.rf_kpa,
            lr_kpa: p.tire_pressures.lr_kpa,
            rr_kpa: p.tire_pressures.rr_kpa,
        },
    }
}

/// Auto-detecting telemetry source. On each `connect()` it probes every
/// supported sim's connector in priority order and adopts the first whose shared
/// memory is present, then delegates to it. If that source later drops, it's
/// cleared so the reader's retry loop re-probes — so the app picks up whichever
/// sim the user launches, whenever they launch it.
///
/// The probe *is* opening the mapping (via each connector's `connect()`), which
/// succeeds only when a sim is running AND publishing telemetry — a stronger,
/// cheaper signal than checking for a running process (a game sitting at its
/// menu, or without the shared-memory plugin, produces no mapping).
#[cfg(windows)]
struct AutoConnector {
    active: Option<Box<dyn SimConnector>>,
}

#[cfg(windows)]
impl AutoConnector {
    fn new() -> Self {
        Self { active: None }
    }

    /// Fresh connectors to probe, in priority order. iRacing first (its
    /// data-ready event makes liveness instant), then LMU.
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
        // Nothing running yet; the reader backs off and retries, re-probing.
        Err(overlay_core::ConnectError::NotRunning)
    }

    fn is_connected(&self) -> bool {
        self.active.as_ref().is_some_and(|c| c.is_connected())
    }

    fn capabilities(&self) -> Capabilities {
        self.active
            .as_ref()
            .map_or_else(Capabilities::default, |c| c.capabilities())
    }

    fn poll(&mut self) -> Option<TelemetrySnapshot> {
        let snap = self.active.as_mut()?.poll();
        // Forget a dropped source so the reader re-detects on the next loop.
        if self.active.as_ref().is_some_and(|c| !c.is_connected()) {
            self.active = None;
        }
        snap
    }
}

/// Pick the telemetry source. `OVERLAY_SOURCE=mock|iracing|lmu|replay|auto`
/// (default auto). Auto probes for whichever sim is running (see
/// [`AutoConnector`]). For replay, `OVERLAY_REPLAY` gives the JSONL path. The
/// live sims are Windows-only; elsewhere we fall back to the mock.
fn build_connector(source: &str) -> Box<dyn SimConnector> {
    if source == "replay" {
        let path =
            std::env::var("OVERLAY_REPLAY").unwrap_or_else(|_| "fixtures/session.jsonl".into());
        return Box::new(ReplayConnector::new(path));
    }
    #[cfg(windows)]
    {
        use iracing_connector::IRacingConnector;
        use lmu_connector::LmuConnector;
        match source {
            "mock" => Box::new(MockConnector::new()),
            "iracing" => Box::new(IRacingConnector::new()),
            "lmu" => Box::new(LmuConnector::new()),
            // "auto" (and any unknown value) → detect whichever sim is running.
            _ => Box::new(AutoConnector::new()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = source;
        Box::new(MockConnector::new())
    }
}

/// Size + position the overlay to fully cover a monitor (so it sits flush over
/// the game). Prefers a non-primary monitor when more than one is present, so it
/// stays off the main gaming display; with a single monitor it covers that one.
/// `OVERLAY_MONITOR=<index>` forces a specific monitor.
fn place_on_secondary_monitor(win: &tauri::WebviewWindow) {
    let monitors = win.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        return;
    }
    let primary = win.primary_monitor().ok().flatten();

    let forced = std::env::var("OVERLAY_MONITOR")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&i| i < monitors.len());

    let idx = forced
        .or_else(|| {
            if monitors.len() > 1 {
                let primary_name = primary.as_ref().and_then(|p| p.name());
                monitors.iter().position(|m| m.name() != primary_name)
            } else {
                None
            }
        })
        .unwrap_or(0);

    let m = &monitors[idx];
    let _ = win.set_position(*m.position());
    let _ = win.set_size(*m.size());
}

/// Show + focus the manager window (from the tray or a second-instance launch).
fn show_manager(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("manager") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Recompute overlay visibility / interactivity from the current state and apply
/// it to the native window, then notify the webviews.
fn reconcile_overlay(app: &AppHandle) {
    let st = app.state::<OverlayState>();
    // Hold the reconcile lock across read+apply so two callers can't interleave
    // (e.g. the watchdog's hide landing after — and undoing — a hotkey's show).
    let _guard = st.reconcile.lock().unwrap_or_else(|p| p.into_inner());
    let editing = st.edit.load(Ordering::SeqCst);
    let visible = st.overlay_visible();

    if let Some(win) = app.get_webview_window("overlay") {
        if visible {
            let _ = win.show();
        } else {
            let _ = win.hide();
        }
        // Baseline is always click-through. While editing, `spawn_cursor_poll`
        // dynamically flips capture on/off as the cursor enters/leaves a widget
        // rect (issue 4b) — this call just re-establishes the click-through
        // baseline on every reconcile (edit toggling off, visibility changes,
        // preview, VR, …), which is correct because the poll thread no-ops
        // entirely whenever `editing` is false.
        let _ = win.set_ignore_cursor_events(true);
    }

    if !editing {
        // Hygiene: drop stale hit-test state so a late-arriving report from a
        // just-exited edit session can't leak into the next one.
        if let Ok(mut regions) = st.hit_regions.lock() {
            regions.clear();
        }
        st.force_capture.store(false, Ordering::SeqCst);
    }

    let _ = app.emit(EVT_EDIT_MODE, editing);
    emit_status(app);
}

/// Issue 4b (click-through to apps under the edit layer): while editing, the
/// overlay window ignores cursor events by default (see `reconcile_overlay`)
/// so clicks on empty space fall through to whatever app is under it. This
/// background thread is what makes widgets/controls still clickable — every
/// tick, while editing, it reads the OS cursor position and flips capture on
/// only when the cursor is over a reported hit region (or a pointer gesture is
/// in progress), then flips it back off the moment it leaves. An ignoring
/// window receives no mouse events at all, so this has to be driven from the
/// OS cursor position rather than DOM pointer events.
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(16);

fn spawn_cursor_poll(app: AppHandle) {
    std::thread::Builder::new()
        .name("edit-cursor-poll".into())
        .spawn(move || {
            // Local — not shared state — so we only call into the window when our
            // own last-applied capture state actually needs to change; tao/Windows
            // additionally no-ops an unchanged flag, but avoiding the cross-thread
            // call entirely when nothing changed keeps this thread cheap.
            let mut capturing = false;
            loop {
                std::thread::sleep(CURSOR_POLL_INTERVAL);
                let st = app.state::<OverlayState>();
                if !st.edit.load(Ordering::SeqCst) {
                    // Not editing: nothing to do. `reconcile_overlay` already owns
                    // the click-through baseline for every other state.
                    if capturing {
                        capturing = false;
                    }
                    continue;
                }
                let Some(win) = app.get_webview_window("overlay") else {
                    continue;
                };

                let want = if st.force_capture.load(Ordering::SeqCst) {
                    // A drag/resize is in progress — stay captured for the whole
                    // gesture regardless of hover position, so `setPointerCapture`
                    // carrying the cursor outside the widget's original rect never
                    // strands the drag (an ignoring window gets no pointermove/up).
                    true
                } else {
                    match (win.cursor_position(), win.inner_position(), win.scale_factor()) {
                        (Ok(cursor), Ok(origin), Ok(scale)) if scale > 0.0 => {
                            // Convert the OS cursor's physical position into the
                            // overlay's logical (CSS-pixel) coordinate space, which
                            // is what the reported hit rects use.
                            let lx = (cursor.x - origin.x as f64) / scale;
                            let ly = (cursor.y - origin.y as f64) / scale;
                            st.hit_regions
                                .lock()
                                .map(|regions| regions.iter().any(|r| r.contains(lx, ly)))
                                .unwrap_or(false)
                        }
                        _ => false,
                    }
                };

                if want != capturing {
                    let _ = win.set_ignore_cursor_events(!want);
                    capturing = want;
                }
            }
        })
        .expect("failed to spawn edit-cursor-poll thread");
}

/// Flip the VR-active flag (so the overlay window stays rendered for capture) and
/// reconcile. Called by the `vr` module when the compositor starts/stops.
pub(crate) fn set_vr_active(app: &AppHandle, active: bool) {
    app.state::<OverlayState>()
        .vr_active
        .store(active, Ordering::SeqCst);
    reconcile_overlay(app);
}

/// Push the current status to the manager (status line / button states).
fn emit_status(app: &AppHandle) {
    let st = app.state::<OverlayState>();
    let source = st.source.lock().map(|s| s.clone()).unwrap_or_default();
    let _ = app.emit(
        EVT_STATUS,
        StatusMsg {
            session_active: st.session_active.load(Ordering::SeqCst),
            editing: st.edit.load(Ordering::SeqCst),
            preview: st.preview.load(Ordering::SeqCst),
            overlay_visible: st.overlay_visible(),
            source,
        },
    );
}

/// Flip the session-active flag and reconcile if it changed. When a session
/// ends we also clear preview/edit so the overlay reliably "disappears".
fn set_session_active(app: &AppHandle, active: bool) {
    let st = app.state::<OverlayState>();
    if active {
        // Telemetry is flowing — claim the launch decision so the startup grace
        // timer won't pop the manager window over a running game.
        st.launch_manager_resolved.store(true, Ordering::SeqCst);
    }
    let prev = st.session_active.swap(active, Ordering::SeqCst);
    if prev == active {
        return;
    }
    if !active {
        st.preview.store(false, Ordering::SeqCst);
        st.edit.store(false, Ordering::SeqCst);
    }
    reconcile_overlay(app);
}

/// Toggle edit mode (from the hotkey or tray). Edit is independent of `preview`:
/// leaving edit when there's no session and no explicit preview hides the overlay,
/// so widgets don't linger after you're done. Use the Preview toggle to keep them.
fn toggle_edit(app: &AppHandle) {
    let st = app.state::<OverlayState>();
    st.edit.fetch_xor(true, Ordering::SeqCst);
    reconcile_overlay(app);
}

/// Register (or re-register) the edit-mode global shortcut from an accelerator
/// string like "CmdOrCtrl+Shift+O".
fn register_edit_hotkey(app: &AppHandle, accel: &str) -> Result<(), String> {
    let new: Shortcut = accel.parse().map_err(|e| format!("invalid hotkey: {e}"))?;
    let gs = app.global_shortcut();

    let st = app.state::<OverlayState>();

    // Clone the current combo out of the guard so we don't hold the lock across
    // the (un)register calls.
    let old = st.edit_hotkey.lock().ok().map(|g| g.clone());

    // Re-applying the combo that's already live is a no-op (registering it a
    // second time would fail as "already registered").
    if old.as_ref() == Some(&new) && gs.is_registered(new.clone()) {
        return Ok(());
    }

    // Register the NEW shortcut first; only drop the old one after success. If
    // the new combo is rejected (taken by another app, etc.) the old hotkey
    // stays registered and our state is untouched.
    gs.on_shortcut(new.clone(), |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_edit(app);
        }
    })
    .map_err(|e| format!("could not register hotkey \"{accel}\": {e}"))?;

    if let Some(old) = old.filter(|o| *o != new) {
        let _ = gs.unregister(old);
    }

    if let Ok(mut cur) = st.edit_hotkey.lock() {
        *cur = new;
    }
    Ok(())
}

// --- Tauri commands (called from the manager webview) ---

#[tauri::command]
fn set_edit(app: AppHandle, editing: bool) {
    let st = app.state::<OverlayState>();
    st.edit.store(editing, Ordering::SeqCst);
    reconcile_overlay(&app);
}

/// Issue 4b (click-through to apps under the edit layer): the frontend
/// (`src/store/hitRegions.ts`) calls this continuously while editing with the
/// current set of on-screen interactive rects (widgets, toolbar, settings
/// panel, the "Done editing" button — anything that opts into native capture),
/// plus whether a pointer gesture is currently in progress. `spawn_cursor_poll`
/// reads this state to decide, each tick, whether the overlay window should
/// currently be capturing the cursor. Ignored while not editing so a stray
/// report from a just-exited session can't resurrect capture.
#[tauri::command]
fn report_hit_regions(app: AppHandle, regions: Vec<HitRect>, force_capture: bool) {
    let st = app.state::<OverlayState>();
    if !st.edit.load(Ordering::SeqCst) {
        return;
    }
    if let Ok(mut r) = st.hit_regions.lock() {
        *r = regions;
    }
    st.force_capture.store(force_capture, Ordering::SeqCst);
}

/// Preview = "keep the overlay on screen even outside a session". Independent of
/// edit mode: when on (and not editing), the overlay is shown but click-through.
#[tauri::command]
fn set_preview(app: AppHandle, enabled: bool) {
    let st = app.state::<OverlayState>();
    st.preview.store(enabled, Ordering::SeqCst);
    reconcile_overlay(&app);
}

#[tauri::command]
fn set_auto_show(app: AppHandle, enabled: bool) {
    app.state::<OverlayState>()
        .auto_show
        .store(enabled, Ordering::SeqCst);
    reconcile_overlay(&app);
}

#[tauri::command]
fn set_edit_hotkey(app: AppHandle, accel: String) -> Result<(), String> {
    register_edit_hotkey(&app, &accel)
}

#[tauri::command]
fn get_status(app: AppHandle) -> StatusMsg {
    let st = app.state::<OverlayState>();
    StatusMsg {
        session_active: st.session_active.load(Ordering::SeqCst),
        editing: st.edit.load(Ordering::SeqCst),
        preview: st.preview.load(Ordering::SeqCst),
        overlay_visible: st.overlay_visible(),
        source: st.source.lock().map(|s| s.clone()).unwrap_or_default(),
    }
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    let win = match app.get_webview_window("overlay") {
        Some(w) => w,
        None => return vec![],
    };
    let monitors = win.available_monitors().unwrap_or_default();
    let primary_name = win
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|p| p.name().cloned());
    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i,
            name: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Display {}", i + 1)),
            width: m.size().width,
            height: m.size().height,
            is_primary: m.name().cloned() == primary_name,
        })
        .collect()
}

/// Move the overlay to a specific monitor, or back to automatic selection
/// (`None` / JS `null` — prefer a secondary monitor, see
/// `place_on_secondary_monitor`).
#[tauri::command]
fn set_overlay_monitor(app: AppHandle, index: Option<usize>) -> Result<(), String> {
    let win = app
        .get_webview_window("overlay")
        .ok_or("no overlay window")?;
    let Some(index) = index else {
        place_on_secondary_monitor(&win);
        return Ok(());
    };
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let m = monitors.get(index).ok_or("monitor index out of range")?;
    win.set_position(*m.position()).map_err(|e| e.to_string())?;
    win.set_size(*m.size()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Path to the persisted overlay config (layouts/profiles), in the app config dir.
fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("overlay-config.json"))
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("app-settings.json"))
}

/// One-time migration for the identifier rename (`com.simoverlay.dev` →
/// `com.trailbrake.app`): the app-config dir is derived from the identifier, so
/// existing installs would otherwise come up with empty layouts/settings after
/// updating. Any config file that exists under the old identifier's dir but not
/// the new one is copied across on startup (copied, not moved, so rolling back
/// to an older build still finds its data).
fn migrate_legacy_config(app: &AppHandle) {
    let Ok(new_dir) = app.path().app_config_dir() else { return };
    let Some(old_dir) = new_dir.parent().map(|p| p.join("com.simoverlay.dev")) else { return };
    if !old_dir.is_dir() {
        return;
    }
    for name in ["overlay-config.json", "app-settings.json"] {
        let src = old_dir.join(name);
        let dst = new_dir.join(name);
        if src.is_file() && !dst.is_file() {
            let _ = std::fs::create_dir_all(&new_dir);
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

#[tauri::command]
fn load_overlay_config(app: AppHandle) -> Option<String> {
    let path = config_path(&app).ok()?;
    std::fs::read_to_string(path).ok()
}

#[tauri::command]
fn save_overlay_config(app: AppHandle, data: String) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_app_settings(app: AppHandle) -> Option<String> {
    let path = settings_path(&app).ok()?;
    std::fs::read_to_string(path).ok()
}

#[tauri::command]
fn save_app_settings(app: AppHandle, data: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, data).map_err(|e| e.to_string())
}

/// Background thread: drive the reader and emit throttled events to the
/// webviews, plus run the session watchdog that auto-shows/hides the overlay.
fn spawn_bridge(app: AppHandle) {
    std::thread::Builder::new()
        .name("telemetry-bridge".into())
        .spawn(move || {
            let source = std::env::var("OVERLAY_SOURCE").unwrap_or_else(|_| "auto".into());
            if let Ok(mut s) = app.state::<OverlayState>().source.lock() {
                *s = source.clone();
            }
            let connector = build_connector(&source);

            let reader = spawn_reader(connector);
            let rx = reader.snapshots();

            // Capabilities must be read live from the reader, not captured once
            // here: with the auto-detecting source, which sim is connected (and
            // thus what it provides) isn't known until `connect()` succeeds on the
            // reader thread. Emit the current (possibly still-empty) caps now, and
            // re-emit fresh on every slow tick below so widgets un-hide the moment
            // a sim connects.
            let _ = app.emit(EVT_CAPS, CapsMsg::from(reader.capabilities()));

            let mut frames = 0u32;
            let mut last_rate = Instant::now();
            let mut reader_hz = 0.0f32;
            // Backdate so the first frame emits slow data / the watchdog can fire
            // immediately. `Instant` subtraction panics if it would precede the
            // clock's epoch (possible within seconds of Windows boot), so fall
            // back to "now" — worst case the first slow emit / timeout is
            // delayed by that same backdate.
            let now = Instant::now();
            let mut last_slow = now.checked_sub(Duration::from_secs(1)).unwrap_or(now);
            let mut last_frame = now.checked_sub(SESSION_TIMEOUT * 2).unwrap_or(now);
            // Backdated so the very first frame always emits immediately.
            let mut last_fast_emit = now.checked_sub(FAST_EMIT_MIN_INTERVAL).unwrap_or(now);

            loop {
                match rx.recv_timeout(Duration::from_millis(400)) {
                    Ok(snap) => {
                        last_frame = Instant::now();
                        // A session is "active" whenever the iRacing.com Simulator is
                        // streaming telemetry — garage *or* track. (The iRacing UI /
                        // launcher app produces no irsdk telemetry, so frames flowing
                        // already means the simulator is the source, not the launcher.)
                        // The garage-vs-track distinction is per widget via `showIn`,
                        // gated on `slow.onTrack` in the overlay; it is deliberately
                        // NOT gated here, so garage-only widgets can show in the pits.
                        set_session_active(&app, true);

                        frames += 1;
                        let now = Instant::now();
                        let since = now.duration_since(last_rate);
                        if since >= Duration::from_secs(1) {
                            reader_hz = frames as f32 / since.as_secs_f32();
                            frames = 0;
                            last_rate = now;
                        }

                        // Throttle to FAST_EMIT_MIN_INTERVAL by dropping this frame's
                        // emit when we're still inside the window since the last one
                        // — the next frame (always the newest available) gets it
                        // instead. Everything else below (session-active, slow/caps
                        // ticks) still runs on every frame, unaffected.
                        if now.duration_since(last_fast_emit) >= FAST_EMIT_MIN_INTERVAL {
                            // Fast telemetry (~60Hz) is only ever consumed by the
                            // overlay window's widgets (their own rAF loop reads
                            // it directly, bypassing React state) — `manager`
                            // never touches it. A global `app.emit` would still
                            // deliver every frame to `manager`'s webview too,
                            // burning CPU there for nothing, so target the
                            // overlay window specifically. Slow/caps stay global
                            // emits below: `manager` legitimately reads slow data
                            // (`useSlow()` in ProfilesPage).
                            if let Some(overlay) = app.get_webview_window("overlay") {
                                if overlay.emit(EVT_FAST, fast_from(&snap, reader_hz)).is_err() {
                                    break; // app shutting down
                                }
                                last_fast_emit = now;
                            }
                            // No overlay window yet (early startup): skip this
                            // frame's fast emit rather than erroring — it isn't
                            // a shutdown condition, just nothing to deliver to.
                        }

                        if snap.meta.changed.slow
                            || now.duration_since(last_slow) >= Duration::from_millis(200)
                        {
                            let _ = app.emit(EVT_CAPS, CapsMsg::from(reader.capabilities()));
                            let _ = app.emit(EVT_SLOW, slow_from(&snap));
                            last_slow = now;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if last_frame.elapsed() > SESSION_TIMEOUT {
                            set_session_active(&app, false);
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }

            drop(reader);
        })
        .expect("failed to spawn telemetry-bridge thread");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Open Trailbrake", true, None::<&str>)?;
    let edit_i = MenuItem::with_id(app, "edit", "Toggle Edit Overlay", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &edit_i, &sep, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Trailbrake")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_manager(app),
            "edit" => toggle_edit(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_manager(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Minimal shape of `app-settings.json` for the one field we need at this
/// point — everything else in `AppSettings` (TS side) is irrelevant here and
/// `#[serde(default)]` means an old/partial/corrupt file just parses as
/// `false` instead of failing.
#[cfg(windows)]
#[derive(Deserialize, Default)]
struct ReduceGpuSetting {
    #[serde(default, rename = "reduceGpu")]
    reduce_gpu: bool,
}

/// Reads the persisted "Reduce GPU usage" preference and, if enabled, sets
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` before Tauri/wry create any
/// WebView2 environment.
///
/// This has to run this early — before `tauri::Builder::default()` — because
/// WebView2 reads this env var once, at webview-creation time. The app's
/// windows are declared statically in `tauri.conf.json` and get created
/// during `.run()`, so by the time an `AppHandle` exists (e.g. inside
/// `.setup()`) it's already too late. That in turn means we can't use
/// `app.path().app_config_dir()` (needs an `AppHandle`) to find the settings
/// file the normal way (see `settings_path` above) — instead we reconstruct
/// the same path by hand from the compiled app identifier + `%APPDATA%`,
/// matching how Tauri v2 resolves `app_config_dir()` on Windows
/// (`%APPDATA%\{identifier}\app-settings.json`).
///
/// The two flags this sets are deliberately narrow: `--disable-gpu-rasterization`
/// and `--disable-accelerated-2d-canvas` move tile/2D-canvas *painting* onto
/// the CPU (relieving a GPU pegged at 99% by the game) while leaving
/// DirectComposition / GPU compositing untouched — so the overlay's
/// transparency and click-through keep working exactly as before. We
/// deliberately do NOT use `--disable-gpu`, `--disable-gpu-compositing`,
/// `--disable-gpu-vsync`, or `--disable-frame-rate-limit` — those disable (or
/// otherwise break) the compositor itself, which breaks transparent windows.
///
/// This is set process-globally (one shared WebView2 environment for both the
/// `manager` and `overlay` windows) rather than per-window, which would need
/// a second WebView2 environment via a distinct `dataDirectory`. That's an
/// intentional tradeoff: per-window environments hit a documented Tauri/WebView2
/// crash class (tauri-apps/tauri#11144, #13092) and cost extra memory for the
/// second environment. Applying CPU rasterization to the manager window too is
/// harmless — it's a plain decorated control UI, not a 60Hz telemetry surface.
///
/// Best-effort and silent: a missing/unreadable/corrupt settings file is
/// treated as "disabled," matching the default-off contract — this must never
/// be a reason the app fails to launch.
///
/// Takes effect only after a relaunch: WebView2 creates its environment (and
/// reads this env var) once per process and reuses it for the process's
/// lifetime, so a change made while running has no effect until the whole
/// process restarts.
#[cfg(windows)]
fn apply_reduce_gpu_env_if_enabled(identifier: &str) {
    let Ok(appdata) = std::env::var("APPDATA") else {
        return;
    };
    let path = std::path::Path::new(&appdata)
        .join(identifier)
        .join("app-settings.json");
    let Ok(data) = std::fs::read_to_string(&path) else {
        return;
    };

    // serde_json is already a direct dependency of this crate (used
    // throughout for the telemetry payloads), so a real parse of the one
    // field we need is no heavier than a string search and, unlike a
    // substring search for `"reduceGpu":true`, isn't fooled by whitespace or
    // key-order differences the frontend's `JSON.stringify` could introduce.
    let enabled = serde_json::from_str::<ReduceGpuSetting>(&data)
        .map(|s| s.reduce_gpu)
        .unwrap_or(false);
    if !enabled {
        return;
    }

    // wry supplies its own default `--disable-features=...` value for this
    // env var when the caller hasn't set one; since we're setting it
    // ourselves, we fold that same feature list in here so we don't lose it
    // (if a future wry version appends instead of replacing, the duplicate is
    // harmless).
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-gpu-rasterization --disable-accelerated-2d-canvas --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    );
}

fn main() {
    // Generated once and reused for both the pre-builder env-var setup (which
    // needs the app identifier, but not a running app) and `.run()` below.
    let ctx = tauri::generate_context!();

    // Windows/WebView2-only; must run before the first WebView2 environment is
    // created, i.e. before `tauri::Builder::default()`'s window setup. See
    // `apply_reduce_gpu_env_if_enabled` for the full mechanism and rationale.
    #[cfg(windows)]
    apply_reduce_gpu_env_if_enabled(&ctx.config().identifier);

    tauri::Builder::default()
        // Must be first: a second launch focuses the existing manager instead of
        // starting a duplicate that would fail to register the global hotkey.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_manager(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // In-app auto-update (manager "Check for updates"): the updater plugin
        // talks to the GitHub Releases manifest; `process` provides the relaunch
        // used after an update installs. Both are driven from the frontend.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Opens external links (Buy Me a Coffee) in the system browser instead
        // of navigating the webview.
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_overlay_config,
            save_overlay_config,
            load_app_settings,
            save_app_settings,
            set_edit,
            report_hit_regions,
            set_preview,
            set_auto_show,
            set_edit_hotkey,
            get_status,
            list_monitors,
            set_overlay_monitor,
            vr::vr_status,
            vr::vr_set_enabled,
            vr::vr_set_layout,
            vr::vr_set_globals,
            vr::vr_recenter,
            lmu_plugin::lmu_plugin_status,
            lmu_plugin::lmu_enable_plugin,
            lmu_plugin::lmu_open_plugins_folder,
            lmu_plugin::lmu_open_download_page,
        ])
        .manage(OverlayState {
            edit: AtomicBool::new(false),
            preview: AtomicBool::new(false),
            session_active: AtomicBool::new(false),
            auto_show: AtomicBool::new(true),
            vr_active: AtomicBool::new(false),
            source: Mutex::new(String::new()),
            edit_hotkey: Mutex::new(
                DEFAULT_EDIT_HOTKEY
                    .parse()
                    .expect("default hotkey must parse"),
            ),
            launch_manager_resolved: AtomicBool::new(false),
            reconcile: Mutex::new(()),
            hit_regions: Mutex::new(Vec::new()),
            force_capture: AtomicBool::new(false),
        })
        .manage(vr::VrState::default())
        .setup(|app| {
            let handle = app.handle().clone();

            // Must run before anything reads config/settings (the frontend asks
            // for them as soon as the manager window loads).
            migrate_legacy_config(&handle);

            // Overlay starts hidden + click-through, parked on a secondary monitor.
            if let Some(win) = app.get_webview_window("overlay") {
                let _ = win.set_ignore_cursor_events(true);
                place_on_secondary_monitor(&win);
                let _ = win.hide();
            }

            // Default edit-mode hotkey; the manager re-applies the saved one on load.
            if let Err(e) = register_edit_hotkey(&handle, DEFAULT_EDIT_HOTKEY) {
                eprintln!("edit-mode hotkey ({DEFAULT_EDIT_HOTKEY}) unavailable: {e}");
            }

            build_tray(&handle)?;
            // Refresh track maps from the published bundle (background, non-blocking,
            // offline-safe — falls back to the compiled-in baseline on any error).
            track_maps::spawn_refresh(&handle);

            // Decide whether to open the control (manager) window. It starts hidden;
            // on a normal desktop launch we show it after a short grace. But if a
            // telemetry session goes live first (we were (re)started mid-race), the
            // first frame claims the decision and we stay in the tray — the overlay
            // auto-shows from telemetry, so we never cover the running game. The
            // tray's "Open Trailbrake" still opens the window on demand.
            let mgr_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let st = mgr_handle.state::<OverlayState>();
                if !st.launch_manager_resolved.swap(true, Ordering::SeqCst)
                    && !st.session_active.load(Ordering::SeqCst)
                {
                    show_manager(&mgr_handle);
                }
            });

            spawn_bridge(handle);
            spawn_cursor_poll(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the manager hides it to the tray instead of quitting.
            if window.label() == "manager" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(ctx)
        .expect("error while running tauri application");
}
