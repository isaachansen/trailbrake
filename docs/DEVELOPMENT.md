# Development

Building, architecture, and maintainer notes for Trailbrake. For what the app
*is* and how to download it, see the [README](../README.md).

## Stack & repo layout

Rust workspace (telemetry backend) + React/TypeScript frontend, shipped as a
Tauri desktop app.

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
scripts/               # fetch-track-maps.mjs, set-version.mjs, shoot-widgets.mjs
fixtures/              # recorded telemetry (JSONL) for replay
docs/                  # ADDING_A_WIDGET.md, ADDING_A_SIM.md, VR.md
```

## Architecture

The boundary the whole project hangs on: **no sim-specific type appears above
`overlay-core`.** A connector reads its sim and normalizes into a
`TelemetrySnapshot`; everything downstream speaks only that.

`TelemetrySnapshot { meta, session, player, cars[] }`, all in documented SI
units (speed m/s, angles rad, pedals 0..1, times s, temps °C). Every
maybe-missing field is `Option<_>` so missing-per-sim data is *handled*, not
faked. `meta.changed { fast, slow }` tells the store which path moved, so a
standings widget never re-renders at 60 Hz.

**Fast/slow split.** The Rust backend owns the reader and emits throttled
`telemetry://fast` (every frame) and `telemetry://slow` (on change, ≤5 Hz)
events. The frontend `store` keeps the fast path *out* of React — fast widgets
read the latest sample + history ring in their own `requestAnimationFrame` loop —
while slow data drives normal React updates.

**Reader performance.** Reading is decoupled from rendering (`reader::spawn_reader`
runs the connector on its own thread, pushing snapshots over a channel). The
iRacing connector opens the shared-memory mapping once, builds the `name → offset`
var map and parses session YAML only on `sessionInfoUpdate`, blocks on
`Local\IRSDKDataValidEvent` instead of busy-polling, and per frame picks the
freshest of the 4 buffers by `tickCount` with a torn-frame re-check.

## Toolchain

1. Install Rust via [rustup](https://rustup.rs).
2. On Windows, install the **Visual Studio Build Tools** "Desktop development
   with C++" workload (MSVC) — Tauri requires it. (~2–4 GB.)
3. Install [Node](https://nodejs.org).

## Running

```sh
# CLI harness — synthetic data, proves the pipeline (any OS):
cargo run -p overlay-cli -- --source mock

# Browser UI iteration (no sim; runs on macOS too). A JS mock feeds the same
# store the real backend does. Press "e" to toggle edit mode.
npm install
npm run dev            # http://localhost:1420

# Full transparent overlay app. Ctrl+Shift+O toggles edit mode.
npm run tauri dev
```

Pick the telemetry source with an env var (default `auto` → iRacing on Windows):

| Env | Effect |
| --- | --- |
| `OVERLAY_SOURCE=mock` | synthetic data |
| `OVERLAY_SOURCE=iracing` | live iRacing |
| `OVERLAY_SOURCE=replay` `OVERLAY_REPLAY=f.jsonl` | recorded session |
| `OVERLAY_MONITOR=<index>` | force the overlay monitor (default: a non-primary one) |

> The installed desktop app has the frontend baked in at build time — it does
> **not** hot-reload. Use `npm run tauri dev` while iterating; rebuild the
> installer only for a shippable artifact.

## Record & replay

```sh
cargo run -p overlay-cli -- --source iracing --record fixtures/spa.jsonl
cargo run -p overlay-cli -- --source replay --replay fixtures/spa.jsonl
```

Fixtures hold *normalized* snapshots (sim-agnostic), so replay runs on any OS.

## Adding things

- **A widget:** write a presentational component + a `WidgetDefinition`
  (`src/widgets/contract.ts`) and register it in `src/widgets/registry.ts` — the
  add-widget menu, schema-driven settings panel, capability hiding, and layout
  persistence pick it up automatically. See [ADDING_A_WIDGET.md](ADDING_A_WIDGET.md).
- **A sim:** implement a `SimConnector` that normalizes into `TelemetrySnapshot`.
  See [ADDING_A_SIM.md](ADDING_A_SIM.md).
- **VR:** opt-in build (`--features vr`, Windows + LLVM). See [VR.md](VR.md).

### Visualizing widgets

`npm run shoot-widgets` renders every widget in isolation with mock data (via the
`?gallery` route) and saves a PNG per widget plus a contact sheet to
`widget-shots/`, for reviewing the UI.

## Track maps

The Track Map widget draws the circuit outline from the connector-supplied
centerline. For iRacing those are baked from iRacing's **own** published
track-map SVGs (clean-room) by `scripts/fetch-track-maps.mjs`, sampled to 400
points, anchored at start/finish, oriented in the driving direction, and
normalized into a 0..1 closed loop (array order == `lapDistPct`). The baked
result lives at `crates/iracing-connector/assets/track_maps.json`.

```sh
npm run fetch-track-maps -- --from-dataset   # bake from a pre-sampled dataset (assets/tracks.json)
npm run fetch-track-maps -- --rebake         # re-bake from the local cache
npm run fetch-track-maps -- --refresh        # ignore cache, re-download
```

Direct iRacing fetch supports OAuth2, cookie/bearer replay, or fully offline
(save the `track/assets` + `track/get` payloads). `track_maps.json` ships
populated; an absent per-track map just renders an empty frame.

## Releasing & auto-updates

Installed copies update themselves via Tauri's updater plugin, pointed at this
repo's GitHub Releases. Each release carries the signed installer plus a
`latest.json` manifest; installed copies check
`releases/latest/download/latest.json` and offer the update under **Settings →
Software updates**. Updates are verified against the minisign public key in
`tauri.conf.json`, so only builds signed with the matching private key are
accepted.

**Cut a release:**

```sh
npm run set-version 0.2.0          # bumps package.json + tauri.conf.json + Cargo.toml
git commit -am "Release v0.2.0"
git tag v0.2.0 && git push origin v0.2.0
```

Pushing the `v*` tag runs `.github/workflows/release.yml`, which builds + signs
the Windows installer and publishes the GitHub Release. Existing installs pick it
up automatically.

**One-time signing-key setup:**

```sh
npm run tauri signer generate -- -w trailbrake-updater.key
```

Add two repo secrets under **Settings → Secrets and variables → Actions**:

- `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `trailbrake-updater.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key password (empty if none).

Keep the private key out of git. Building locally without these set produces a
working installer but skips the (signed) updater artifacts.

## Build a one-off installer

```sh
npm run tauri build
```

Output: `target/release/bundle/nsis/Trailbrake_<version>_x64-setup.exe`.
