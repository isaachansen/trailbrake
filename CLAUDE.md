# Trailbrake (sim-overlay)

High-performance sim-racing telemetry overlay. Tauri shell, React + TS
frontend (`src/`), Rust telemetry core (`crates/`, `src-tauri/`). Ships as
Trailbrake (ALPHA) with a signed auto-updater; pushing a `v*` tag builds and
publishes the release.

## Architecture in 60 seconds

- **Two windows, one bundle, routed by window label**: `manager` (decorated
  control UI — widgets, profiles, hotkeys) and `overlay` (transparent,
  click-through, always-on-top canvas the widgets composite onto the game).
- **The core seam**: no sim-specific type exists above `overlay-core`. A
  connector (`iracing-connector`, `lmu-connector`, mock, replay) normalizes
  its sim into `TelemetrySnapshot`; everything downstream speaks only that.
  `OVERLAY_SOURCE=mock|iracing|lmu|replay|auto` picks the source (default
  `auto` detects a running sim).
- **Data flow**: sim shared memory → connector → `TelemetrySnapshot`
  (`crates/overlay-core`, SI units) → `src-tauri/src/main.rs` bridge
  (`FastSample`/`SlowSample`/`Capabilities` structs + `*_from` mappers) →
  Tauri events `telemetry://fast|slow|caps` → `src/store/transport.ts` →
  `TelemetryStore` (`src/store/store.ts`) → widgets.
- **Fast/slow split (perf non-negotiable)**: fast (~60 Hz pedals/rpm/steering)
  NEVER goes through React state — fast widgets read `store.latestFast` /
  `store.history` in their own rAF loop (`InputGraph.tsx` is the reference).
  Slow (session/standings, ≤5 Hz) uses `useSlow()`/`useCaps()`
  (`src/store/hooks.ts`). Sentinel cleanup happens once in `sanitizeSlow`
  (`store.ts`) — widgets never re-clean.
- **Widgets are registry-driven** (`src/widgets/registry.ts`): a widget = a
  presentational component + a `WidgetDefinition` (`src/widgets/contract.ts`)
  exported from one file in `src/widgets/`, then one import + array entry in
  the registry. Menus, schema-driven settings (incl. `visibleWhen` conditional
  fields), capability hiding, and layout persistence pick it up automatically.

## Non-negotiables

- **Never fake data.** Every maybe-absent value is `Option<_>` / `| null`;
  a widget hides the field or shows `--`, never a fabricated zero. Set
  `Capabilities` truthfully per sim.
- **SI units everywhere** (m/s, rad, 0..1 pedals, seconds, °C). Convert only
  at display time (`src/widgets/format.ts`).
- **Visibility is two layers — never conflate them.** Window-level
  `session_active` (Rust) = sim is streaming at all (garage OR track).
  Per-widget garage/track = `WidgetInstance.showIn` gated on `slow.onTrack`
  in `WidgetHost`. Never gate `session_active` on on-track.
- **New snapshot fields ripple across four hops**: `snapshot.rs`,
  `src-tauri/src/main.rs` (payload structs AND `*_from` mappers),
  `src/store/types.ts`, and both mocks (`overlay-core/src/mock.rs`,
  `src/store/mockSource.ts`). Add `#[serde(default)]` so old replay fixtures
  still load. Don't half-wire a field.
- **Edit-mode chrome must be WYSIWYG**: the title/✕ chip floats outside the
  panel; widget content must be pixel-identical in and out of edit mode.
- **Anything clickable while editing needs inline `style.pointerEvents =
  "auto"`** — the click-through hit-tester (`src/store/hitRegions.ts` +
  `spawn_cursor_poll` in `main.rs`) scans for exactly that convention. A
  class-based style silently breaks it.

## Design system (visual work = screenshot-verified, never code-read-only)

- Tokens live in `src/theme/theme.ts` — glass surfaces + `panelBlur`, Saira
  Condensed (`font.family`), Saira SemiCondensed tracked uppercase labels
  (`font.label`), JetBrains Mono telemetry digits (`font.mono`, always
  `tabular-nums` for compared numbers). Colors: `accent` pink = player,
  `gain` green / `loss` red, `best` purple, `clutch` cyan, `amber`. Never
  hardcode hex; race/flag/tyre/license lookups are in `src/widgets/raceColors.ts`.
- Spacing: outer padding `theme.widgetPad`, gaps from `theme.space`
  (xs/sm/md/lg/xl), radius `theme.radius`. Content fills or centers — no dead
  bands, no edge-touching, `defaultSize` matches content (internal
  `overflow:hidden`+`flex:1` defeats shrink-to-fit; size correctly).
- **Verify by rendering**: `npm run shoot-widgets` (all + `_contact-sheet.png`),
  `-- --widget=<id>`, `--bg=light` (contrast), `--size=min` (clipping),
  `--config='{...}'` (specific states). Judge widgets against their siblings
  on the contact sheet, not in isolation — the bar is broadcast quality.
  The `visualize-widgets` skill and `.claude/agents/widget-designer.md` carry
  the full rubric.

## Commands

- `npm run dev` — browser-only UI dev (JS mock, `?gallery` route available).
- `npm run dev:app` — the desktop app with a **separate dev identity**
  ("Trailbrake Dev", `com.trailbrake.dev` via `tauri.dev.conf.json`): own
  mutex + own `%APPDATA%`, runs side-by-side with an installed copy. If no
  window appears: manager may be in the tray (telemetry claimed the launch),
  or port 1421 is squatted by an orphaned Vite (`netstat -ano | findstr 1421`).
- `npx tsc --noEmit` after any TS change; `cargo check` (in `src-tauri/`)
  after any Rust change. Both must pass.
- Releases: use the `cut-release` skill (`npm run set-version`, lock sync,
  tag → `release.yml` builds/signs/publishes; updater reads `latest.json`).

## npm supply-chain rules (hard rules, CI-enforced)

- **NEVER raw `npm install <pkg>` / `npm update`.** Add or update packages
  only via `npm run add -- <pkg>[@version] [--dev]` — it enforces a 14-day
  publish-age cooldown and pins exactly (worm-compromised releases get
  yanked within days; the cooldown skips the risk window).
- `.npmrc` sets `ignore-scripts=true` + `save-exact=true`. Never weaken
  these or pass `--ignore-scripts=false`. A package that "needs" an install
  script is a red flag — surface it, don't work around it.
- `npm run check-deps` audits every pinned version's publish age;
  `.github/workflows/dep-age.yml` runs it on any manifest change and blocks
  young/unverifiable versions.
- Cargo has no equivalent gate (`build.rs` runs at compile time) — flag new
  Rust deps to the owner rather than improvising.

## Working norms

- Working tree often carries concurrent in-progress work — never
  `git checkout`/`reset`/`stash` files you didn't change; commit per-effort
  with each commit buildable.
- Widgets read the store; they never invoke sim-specific commands. If widget
  work seems to need a new telemetry field, stop and flag it.
- Mock data: `src/store/mockSource.ts` (+ scenario stores in
  `src/manager/previewStore.ts`); gallery `?flags=<bitfield>` forces Flag
  states for capture. `widget-shots/` is regenerable scratch (gitignored).
- Community data (Lovely Sim Racing track/car data) is CC BY-NC-SA — keep
  attribution and ShareAlike; the project is free/non-commercial.
