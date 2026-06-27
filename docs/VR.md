# VR overlays (OpenVR / OpenXR)

Trailbrake can mirror its widgets into VR: each visible widget becomes its own
floating panel ("quad") in the headset, placed where it sits on the flat overlay.
Drag a widget in the 2-D editor and its VR panel moves to the matching spot — so
panels stay spread around the cockpit, not clumped.

## How it works

```
overlay window (all visible widgets, on a monitor)
   │  Windows Graphics Capture  (~30 Hz)
   ▼
one D3D11 texture of the whole overlay ──► CPU readback (BGRA)
   │  crop per widget by its on-screen rectangle  (→ RGBA)
   ▼
one OpenVR overlay (quad) per widget ── SetOverlayRaw + transform
   ▼
SteamVR composites each panel in the cockpit
```

The overlay window (the authority for what's on screen) sends the backend the
rectangle of every visible widget; the compositor crops each one out of the
captured frame and draws it as a panel. A widget's normalised screen position
maps to an angular position in front of you (`crates/vr-overlay/src/transform.rs`),
scaled by the global distance/size and the per-widget depth.

## Backends

| Backend | State | Notes |
|---|---|---|
| **OpenVR (SteamVR)** | working | The only runtime that composites a foreign overlay on top of a running sim. Use this. |
| **OpenXR** | best-effort | Detects `XR_EXTX_overlay` and lights up if a runtime ever exposes it; **no shipping runtime does today** (SteamVR/WMR/Meta), so it reports unsupported and falls back to OpenVR. |

Your sim must run **through SteamVR** for the panels to appear (e.g. iRacing in
OpenVR mode, or any sim routed via SteamVR). A game on a native Oculus/OpenXR
runtime won't show OpenVR overlays — that's a platform limitation, not a bug.

## Building with VR support

VR is **opt-in** behind the `vr` Cargo feature. The default build pulls no VR
dependencies and runs everywhere; the VR controls simply report "unavailable".

Prerequisites for the real build (Windows only):

- **LLVM / libclang** — `ovr_overlay` binds OpenVR through `autocxx`/bindgen.
  Install LLVM and, if it isn't auto-detected, set `LIBCLANG_PATH`, e.g.
  `setx LIBCLANG_PATH "C:\Program Files\LLVM\bin"`.
- **MSVC C++ build tools + Windows SDK** (already present if you build Tauri).

Then:

```sh
# dev
cargo run -p sim-overlay-app --features vr
# or, with the Tauri CLI / frontend
npm run tauri -- dev -- --features vr        # dev
npm run tauri -- build -- --features vr      # release
```

### Runtime DLL

`ovr_overlay` links `openvr_api.dll`. For a packaged build, place
`openvr_api.dll` (from the OpenVR SDK or a SteamVR install) next to the
executable, or add it to `tauri.conf.json` → `bundle.resources`. SteamVR ships
the DLL, so a dev run with SteamVR installed usually finds it; if the app fails
to start with a missing-DLL error, copy `openvr_api.dll` into `target/<profile>/`.

## Using it

1. Start SteamVR and launch your sim in VR (through SteamVR).
2. Open the Trailbrake manager → **Settings → Virtual reality**.
3. Toggle **Enable VR overlays**. The status line shows the active backend or the
   reason it couldn't start (e.g. "SteamVR not running").
4. Arrange widgets as usual in edit mode — their VR panels track the 2-D layout.
5. Tune **Distance / Panel size / Curvature / Follow head**, and per-widget
   **VR depth** (on each widget's settings card) to push a panel nearer/farther.
6. **Recenter** re-anchors panels to your seated view (or use SteamVR's recenter).

## Limitations

- **OpenXR overlay compositing is unavailable on every current runtime.** The
  OpenXR backend's detection is real, but the composite path is unexercisable
  today, so VR effectively runs on OpenVR.
- **Windows + SteamVR only.**
- **`backdrop-filter` blur** in widget panels samples the desktop behind the
  window, not the cockpit — prefer higher panel opacity in VR.
- Recenter defers to SteamVR's seated reset (the compositor crate doesn't read
  HMD pose directly).

## Code map

- `crates/vr-overlay/` — the compositor crate.
  - `lib.rs` — public types (`VrWidget`, `VrGlobals`, `VrStatus`, `BackendKind`).
  - `backend.rs` — the `VrBackend` trait (one impl per runtime).
  - `openvr.rs` / `openxr.rs` — the two backends.
  - `capture.rs` — Windows Graphics Capture of the overlay window.
  - `transform.rs` — 2-D-position → 3-D-pose math (pure, unit-tested).
  - `imp.rs` — `VrManager`: render thread that captures, crops, and pushes panels.
  - `stub.rs` — no-op manager for non-Windows / non-`vr` builds.
- `src-tauri/src/vr.rs` — Tauri commands (`vr_set_enabled`, `vr_set_layout`, …).
- Frontend: `store/appSettings.ts` (VR settings), `store/controls.ts` (command
  wrappers), `OverlayApp.tsx` (pushes the visible-widget layout), and
  `manager/pages/SettingsPage.tsx` (the Virtual reality card).

## Verify

```sh
cargo test -p vr-overlay --lib              # transform math
cargo check                                 # default build (stub) — cross-platform
cargo check -p vr-overlay --features _wgc_check   # Windows Graphics Capture compiles
npm run build                               # frontend typecheck + build
```

Full end-to-end requires a headset + SteamVR (can't be automated).
