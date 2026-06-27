# sim-overlay

A high-performance, customizable telemetry overlay for racing sims. iRacing
first, but the sim is a swappable data source so adding other titles later is
mostly "write one adapter."

**All four planned phases are complete.** The app is a transparent, always-on-top
overlay (Tauri) with a separate manager window, **15 registry-driven widgets**, a
fast/slow telemetry split, per-widget configuration with saved profiles, record &
replay, and bundled iRacing track maps. The one thing never validated against the
real thing is the **live iRacing connector** end-to-end (it compiles and the YAML
parser is unit-tested, but needs an on-track session) — everything else is verified
via the mock, replay, the browser, and the native app. Build phases are tracked in
**Status / next** at the bottom.

## Repo layout

```
crates/
  overlay-core/        # sim-agnostic: TelemetrySnapshot, SimConnector trait,
                       #   reader loop + fan-out, MockConnector, record/replay
  iracing-connector/   # Windows-only: irsdk shared-memory reader → snapshot;
                       #   bundled track maps (track_map.rs + assets/track_maps.json)
  lmu-connector/       # stubbed seam (Le Mans Ultimate / rFactor2) — not implemented
  vr-overlay/          # opt-in VR compositor: per-widget OpenVR/OpenXR panels
                       #   (Windows + `vr` feature) — see docs/VR.md
  overlay-cli/         # dev harness: run a source, print normalized snapshots
src/                   # React + TS frontend: widgets, store (fast/slow), manager UI
src-tauri/             # Tauri shell: windows, edit hotkey, reader→webview bridge
scripts/               # fetch-track-maps.mjs (bakes the iRacing track-map asset)
fixtures/              # recorded telemetry (JSONL) for replay
docs/                  # ADDING_A_WIDGET.md, ADDING_A_SIM.md, VR.md
```

**VR:** widgets can also be mirrored into VR as individually-placed floating
panels (OpenVR/SteamVR; OpenXR best-effort). Opt-in build (`--features vr`,
Windows + LLVM). See **[docs/VR.md](docs/VR.md)**.

The architecture boundary the whole project hangs on: **no iRacing-specific
type appears above `overlay-core`.** A connector reads its sim and normalizes
into `TelemetrySnapshot`; everything downstream speaks only that.

### The normalized model (`overlay-core::snapshot`)

`TelemetrySnapshot { meta, session, player, cars[] }`, all in documented SI
units (speed m/s, angles rad, pedals 0..1, times s, temps °C). Every
maybe-missing field is `Option<_>` so missing-per-sim data is *handled*, not
faked. `meta.changed { fast, slow }` tells the (future) frontend store which
path moved, so a standings widget never re-renders at 60 Hz.

### How the perf non-negotiables show up in the reader

- **Decouple reading from rendering** — `reader::spawn_reader` runs the
  connector on its own thread and pushes snapshots over a channel; the CLI
  prints at a throttled rate independent of the reader.
- **Read cheaply** — the iRacing connector opens the mapping once, builds the
  `name → offset` var map and parses the session YAML **only when the session
  changes** (`sessionInfoUpdate`), then per frame does: pick the freshest of the
  4 buffers by `tickCount`, one copy (with a torn-frame re-check), index by
  precomputed offsets.
- **Wait, don't spin** — it blocks on `Local\IRSDKDataValidEvent` instead of
  busy-polling.
- **Centralize** — one connector owns the sim connection; nothing else touches
  shared memory.

## Running it

> Requires a Rust toolchain — see **Toolchain** below.

```sh
# Anywhere (macOS/Linux/Windows): synthetic data, proves the pipeline.
cargo run -p overlay-cli -- --source mock

# Windows + iRacing running: real telemetry.
cargo run -p overlay-cli -- --source iracing

# Auto-detect (iRacing if present, else falls back to mock on non-Windows):
cargo run -p overlay-cli

# Bounded run (useful for quick checks / CI):
cargo run -p overlay-cli -- --source mock --duration 5
```

You should see one line per (throttled) update, e.g.:

```
[Mock] t=  1.00s reader= 60.0Hz tick=60     | gear 4 spd  192.4km/h rpm  7180 | thr 0.91 brk 0.00 clu 0.00 str +0.12rad | lap 0 dpct  12.3% Δbest +0.03s | last     -- best     -- | Mock Speedway
```

## Toolchain

You need a Rust toolchain, a C/C++ linker, and Node. On a fresh machine:

1. Install Rust via [rustup](https://rustup.rs).
2. Provide a linker on Windows: install the *Visual Studio Build Tools* "Desktop
   development with C++" workload (MSVC). This is also what Tauri requires on
   Windows, so it covers the whole project. Heavier download (~2–4 GB). (A GNU
   toolchain works for the core/connector alone, but Tauri wants MSVC.)
3. Install [Node](https://nodejs.org) (for the frontend / Tauri app).

### Known caveat: the Win32 FFI needs a compile pass

All `windows`-crate FFI is confined to `iracing-connector/src/irsdk/mmap.rs`,
targeting `windows = "0.59"`. windows-rs occasionally reshapes `BOOL`/`Param`
bounds between versions, so the `OpenFileMappingW`/`OpenEventW` boolean
arguments may need a one-line tweak on first compile. Everything else is plain
safe Rust over `&[u8]` and the mock path is fully portable.

## The overlay app (Phase 2)

Frontend lives at the repo root (`src/`, Vite + React + TS); the Tauri shell is
in `src-tauri/`.

```sh
# UI iteration in a plain browser (no sim, runs on macOS too). A JS mock feeds
# the same store the real backend does. Press "e" to toggle edit mode.
npm install
npm run dev            # http://localhost:1420

# The full transparent overlay app (Windows/macOS). Ctrl+Shift+O toggles edit
# mode (click-through off + drag widgets + perf HUD).
npm run tauri dev
# Pick the source with an env var (default: auto → iRacing on Windows):
#   OVERLAY_SOURCE=mock                          synthetic data
#   OVERLAY_SOURCE=iracing                       live iRacing
#   OVERLAY_SOURCE=replay  OVERLAY_REPLAY=f.jsonl  recorded session
# The overlay opens on a non-primary monitor by default (so it's off your main
# gaming display). Force one with OVERLAY_MONITOR=<index>.
```

### Record & replay

Capture real telemetry and develop against it anywhere (incl. macOS):

```sh
# Record a session to a JSONL fixture (works with any source):
cargo run -p overlay-cli -- --source iracing --record fixtures/spa.jsonl
# Replay it through the normal pipeline at the original cadence:
cargo run -p overlay-cli -- --source replay --replay fixtures/spa.jsonl
```

Fixtures hold *normalized* snapshots (sim-agnostic), so replay runs on any OS.

How the data flows: the Rust backend owns the reader (overlay-core) and emits
throttled `telemetry://fast` (every frame) and `telemetry://slow` (on change,
≤5 Hz) events. The frontend `store` keeps the fast path *out* of React — the
Input graph reads the latest sample + history ring in its own rAF loop — while
slow data drives normal React updates. The perf HUD reports reader / push /
graph rates so we can confirm we're meeting the §3 targets.

### Track maps

The Track Map widget draws the circuit outline from the connector-supplied
centerline (`session.track_path`). For iRacing those centerlines are baked from
iRacing's **own** published track-map SVGs (clean-room — no third-party data) by
a one-time script. Install the deps first:

```sh
npm install   # adds svg-path-properties (+ iracing-api, used only by legacy auth)
```

The script then downloads each track's active / start-finish / turns SVG layers,
samples the centerline into 400 points, anchors index 0 on the start/finish line,
orients it in the driving direction, and normalizes it into a 0..1
aspect-preserved closed loop (array order == `lapDistPct`, so the widget places
cars directly), writing `crates/iracing-connector/assets/track_maps.json`.

**From a pre-sampled dataset (no iRacing access needed).** If you already have a
dataset keyed by iRacing track id with per-track `sampledPoints` (`{ pct, x, y }`,
aspect-normalized), `sfOffsetPct`, and `pathReversed` — e.g. `assets/tracks.json` —
convert it straight to the bundle:

```sh
npm run fetch-track-maps -- --from-dataset      # reads assets/tracks.json
TRACKS_DATASET=path/to/other.json npm run fetch-track-maps -- --from-dataset
```

This is the current default source for this repo. The modes below fetch from
iRacing directly and only matter if you're regenerating from iRacing's API.

> **Corner labels.** The `--from-dataset` path derives corner markers from the
> dataset's `normalizedTurns`, which can over-count and mis-place them (e.g. Red
> Bull Ring bakes 16 markers for a 10-corner track). The direct-fetch modes below
> read the corners straight from iRacing's **turns** SVG layer — the same source
> iRacing's own map uses — keeping its native labels and placement. Prefer a
> direct/offline re-bake if your corner numbers look wrong.

**Authenticating (direct iRacing fetch).** iRacing retired legacy
username/password API auth on 2025-12-09 *and has paused new OAuth client
registration*, so a fresh direct fetch may not be possible right now. When it is,
pick whichever fits:

```powershell
# OAuth2 password_limited grant (recommended). Needs an OAuth client registered
# with iRacing (client id/secret) plus your account login:
$env:IRACING_CLIENT_ID="…"; $env:IRACING_CLIENT_SECRET="…"; `
  $env:IRACING_LOGIN="you@example.com"; $env:IRACING_PWD="…"; npm run fetch-track-maps

# Cookie/Bearer replay: copy the `cookie:` (and `authorization:`) request headers
# from a signed-in `members-ng.iracing.com/data/…` call in DevTools → Network:
$env:IRACING_COOKIE="…"; $env:IRACING_AUTH="Bearer …"; npm run fetch-track-maps
```

Or fully offline — save the two data payloads from a signed-in browser and bake
with no credentials (the map SVGs themselves are on a public CDN):

```sh
#   https://members-ng.iracing.com/data/track/assets  ->  scripts/iracing-data/assets.json
#   https://members-ng.iracing.com/data/track/get     ->  scripts/iracing-data/tracks.json
npm run fetch-track-maps -- --offline
```

(Those endpoints return a `{ "link": … }` wrapper; the script follows the link
itself, but that presigned URL expires in minutes, so run promptly.)

Raw fetched geometry is cached under `scripts/.track-map-cache/`, so re-baking is
free (no credentials):

```sh
# If a track renders backwards, add an override and re-bake from cache:
#   scripts/track-map-overrides.json :  { "<trackId>": { "direction": -1 } }
npm run fetch-track-maps -- --rebake     # bake from cache only
npm run fetch-track-maps -- --refresh    # ignore cache, re-download everything
```

`track_maps.json` ships empty (`{}`) so the crate builds before you fetch; until
it's populated the widget just shows an empty frame (capability stays on — the
per-track map is simply absent).

## Widgets & layout (Phase 3)

The customizability core. A widget is a presentational component + a
`WidgetDefinition` (`src/widgets/contract.ts`) declaring its default size,
required data paths/capabilities, and a `configSchema`. Register it in
`src/widgets/registry.ts` — that's the whole "add a widget" change; the settings
panel, add-widget menu, and persistence pick it up automatically.

- **Widgets (15):** Standings, Relative, Input graph (fast/canvas), Delta bar,
  Dash Cluster, Fuel & Session, Radar, Track Map, Flatmap, Spotter, Traffic
  Indicator, Pit Board, Race Control, Chat, Garage Cover. Each declares its
  required data paths + capabilities, so widgets a given sim can't feed hide
  automatically (e.g. the Radar/Spotter need lateral car offsets that iRacing
  doesn't expose, so they show only under the mock).
- **Layout store** (`src/store/layout.ts`): widget instances carry
  position/size/scale/opacity/visibility/lock + per-widget config, grouped into
  **named profiles**, autosaved (debounced) and reloaded on startup. Persistence
  goes through Tauri commands (`overlay-config.json` in the app config dir) or
  localStorage in the browser.
- **Edit mode** (Ctrl+Shift+O, or `e` in the browser): drag to move, resize from
  the corner, click to select → settings panel (common props + schema-driven
  options), plus a toolbar to switch/create/delete profiles and add widgets.

The Relative/Standings widgets need the field: the mock (Rust + JS) emits a
small multiclass grid, and the iRacing connector populates `cars[]` from the
`CarIdx*` arrays + a tolerant `DriverInfo` YAML parse (names/class/color/iRating).

## Releasing & auto-updates

The app updates itself in place — users never reinstall. It uses Tauri's updater
plugin pointed at this repo's GitHub Releases: each release carries the signed
installer plus a `latest.json` manifest, and installed copies check
`releases/latest/download/latest.json` and offer the update under **Settings →
Software updates** (download + verify + install + relaunch). Every update is
verified against the minisign public key baked into `tauri.conf.json`, so only
builds signed with the matching private key are accepted.

**Cut a release:**

```sh
npm run set-version 0.2.0          # bumps package.json + tauri.conf.json + Cargo.toml
git commit -am "Release v0.2.0"
git tag v0.2.0 && git push origin v0.2.0
```

Pushing the `v*` tag runs `.github/workflows/release.yml`, which builds + signs
the Windows installer and publishes the GitHub Release (installer + `latest.json`).
That's the whole "upload a new version" step — existing installs pick it up.

**One-time setup — signing key:** generate a keypair and store the private half
as a repo secret (the public half lives in `tauri.conf.json`):

```sh
npm run tauri signer generate -- -w trailbrake-updater.key
```

Add two repo secrets under **Settings → Secrets and variables → Actions**:

- `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `trailbrake-updater.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set (empty value if none).

Keep the private key out of git. Lose it and you can't sign updates that existing
installs will accept — you'd have to ship a new public key via a full reinstall.

## Status / next

- **Phase 1:** reader spike + skeleton + mock. ✅
- **Phase 2:** Tauri shell, fast/slow store, Input-graph widget, edit-mode
  hotkey, perf HUD. ✅
- **Phase 3:** widget registry + base contract + theming + per-widget config &
  saved profiles; Delta/Relative/Standings; move/resize/settings. ✅
- **Phase 4:** record & replay, per-car profile auto-switching, capability-based
  hiding, second-monitor placement, stubbed `LmuConnector` seam
  (`crates/lmu-connector`), and the [add-a-widget](docs/ADDING_A_WIDGET.md) /
  [add-a-sim](docs/ADDING_A_SIM.md) docs. ✅

All four planned phases are complete. The one thing never validated against the
real thing is the **live iRacing connector** (`cars[]`/DriverInfo/CarIdx reads) —
it compiles and the YAML parser is unit-tested, but it needs an on-track session
to confirm end-to-end. Everything else is verified via the mock, replay, the
browser, and the native app.
