# Audit implementation progress — 2026-07-01

Source of truth for findings: `docs/audit-2026-07-01.md` (item IDs referenced below).

NOTE (user directive): all subagents run on Sonnet (`model: "sonnet"`), never Fable.

## Wave 1 — ✅ COMPLETE (verified: tsc clean, cargo check+test --workspace green, vite build green)

All items in the table below landed. Extras beyond the plan: capability file split
(manager vs overlay windows), Toolbar.tsx "+ Profile" error surfacing, new
`src/widgets/useCarName.ts` narrow subscription, `sync.ts` EVT_LAYOUT_REQUEST handshake.
Flatmap cap gate resolved as `[]` (nothing gates lapDistPct today).

## Wave 2a — ✅ COMPLETE
- theme.ts T1: surface rgba(18,20,27,0.78) + brightness(0.55) in panelBlur; WidgetTitle.tsx T3 shrink fix.
- Fonts: 13 woff2 bundled to public/fonts (Sora dropped — unused; Bricolage 700 only), Google Fonts links removed, strict CSP set in tauri.conf.json. Follow-ups: manual Tauri launch to watch for CSP violations; latent "Saira SemiCondensed" (no-space) family-name bug documented in src/fonts.css.

## Wave 2b — ✅ COMPLETE (4 polish groups, all screenshot-verified; final contact sheet reviewed clean)
Also fixed during/after: HighlightedDriver hooks-after-early-return crash (blank browser page — orchestrator hotfix), DashCluster LED gap segments now stripped from profiles at load (carLeds.ts stripGaps — no dead slots, also hardens Tachometer shift point).

## User-requested additions — ✅ COMPLETE
- Relative F1-style position-swap animation (identity-keyed rows, 400ms slides, enter/exit fades, gain/loss flash, FitContent capacity guard) + mock overtake pacing (player pass ~every 20s, live-derived ranks).
- Same animation ported to Standings (per-class-group slot boxes; cross-group moves fade; TODO note to share code with Relative later). Cross-class moves untested vs real gameplay (mock classes are stable).
- Relative horizontal density: gap 0.8→1em, row pad 0.75em, defaultSize.w 400→520 (fixed-em columns were starving the 1fr name column at scale 1).
- Relative slack centering + widgetPad; LaunchAssist preview scenario (previewStore, 9s launch loop).
- Spotter: liquid-glass panel support (shared glassChrome/GlassSpecular helpers) + idle caption removed (active CAR LEFT/RIGHT/3-WIDE only). Gallery gap noted: ?gallery route isn't wired to the real settings store (standalone ?glass=1 flag, skips transparentPanel widgets).
- FieldListEditor rework: HTML5 drag removed (pointer-drag on grip only + ▲/▼ buttons), R/Q/P letter chips (aria-pressed, keyboard), fixed pill-over-label overlap. Verified 18/18 clicks, reorder + persistence round-trip.

## Final verification (2026-07-01, end of session)
tsc clean · `npm run build` green · cargo check/test --workspace green (wave-1 state; Rust untouched since) · fresh 29-widget contact sheet reviewed — all audit items visibly resolved. NOTHING COMMITTED — user must request commits.

## Wave 2b original plan (for reference)
- P1 spatial: TrackMap declutter + dark under-stroke, Flatmap strokes/height, Radar orientation cue + range tag, Traffic bar track, Spotter caption. (T2 mid-grey pattern)
- P2 states: LaunchAssist opacity floor 0.45 + gallery stopped state (may touch src/manager/previewStore.ts — P2 owns it), SetupComparison empty state + padding, RaceControl honest empty + bottom anchor + demo feed, TelemetryInspector chrome removal + scroll fade, Chat height/header dot, Flag checker dark cells.
- P3 tables/pit: Relative slack + padding, Standings slack/padding/header call, HighlightedDriver overflow/purple/iRT, FuelSession unit space, PitBoard tokens/header, PitlaneHelper speed marker + tile density, Weather vector icons + min clip.
- P4 glance: DashCluster insets, HeartRate balance, DeltaBar padding token, SectorDelta tokens + chip borders, CornerName eyebrow (partially done in wave 1 — verify).
- Each agent: apply theme.widgetPad/space (T4) to its own widgets; verify with shoot → Read → iterate at default/min/light.

## Wave-1 original ownership table (for reference)

| Area (owner boundary) | Items |
|---|---|
| `crates/iracing-connector/**` | B1 SessionNum session type, B2 shm bounds validation, B3 session-state reset, B4 tick dedup, pace-car total_cars |
| `src-tauri/**`, `crates/overlay-core/**`, `.github/workflows/**`, `scripts/set-version.mjs` | S6 vr-visible status, S5-Rust hotkey register-before-unregister, reconcile mutex, VR TOCTOU, bounded reader channel, replay parse errors, Rust-mock consistency, `set_overlay_monitor(null)`=auto, Instant underflow, CI cache path, set-version Cargo.lock, trackmaps 100KB guard, capabilities trim |
| `src/store/**`, `src/components/**`, `src/OverlayApp.tsx`, `src/App.tsx`, `src/manager/pages/ProfilesPage.tsx` | S1 effective values, S2 mock-carName persist gate, S3 clear stale telemetry, S4 sync handshake + init ordering, S5-TS hotkey (returns Promise<string\|null>), section-4 minors (transport retry, pointercancel, VR throttle, JSON validation, persist errors, monitor auto, updater close), M3 resetConfig size, M5 newProfile duplicates current + error strings, mockSource honesty (delta gating, carName=BMW M4 GT3 EVO, history pre-seed), render `text` config in SettingsPanel |
| `src/widgets/**` | W1 PRED math, W2 delta gating, W3 gap seconds (config migrate distanceThresholdM→gapThresholdS), W4 gaps/#null, W5 HeartRate text field, W6 shift-from-profile + bar ticks, W7 GarageCover copy, W8 CornerName next-turn, section-5 minors (requiredPaths, showHistory, lapDistPct −1, rAF alloc hoists, raceColors stability + full-field call sites, PitlaneHelper fallback, SlowCarAhead wording, Weather arrow, Standings measure deps + has.car, SetupComparison label, carName narrow subscription, Flatmap cap gate) |
| `src/manager/**` (minus ProfilesPage.tsx), `src/gallery/**` | M1 preview opacity mirrors WidgetHost, M2 hex draft input, M4 VR error inline, section-6 minors (unconditional hook, gallery mutation + config merge, show-on-desktop honesty, state-chip :disabled + action buttons, modal Esc/focus, cw-pop portal, SoftwareUpdates hoisted state, hotkey capture Esc + error render, Toggle keyboard, slider units, Tachometer meta description), render `text` config in WidgetConfigEditor |

Pre-work done by orchestrator: `src/widgets/contract.ts` — added ConfigField `{ type: "text"; placeholder? }`.

## After wave 1 lands (next session if needed)
1. Verify: `npx tsc --noEmit`, `cargo check --workspace`, `cargo test --workspace`, `npm run build`; fix cross-area integration fallout (esp. setEditHotkey signature, set_overlay_monitor null arg, text-field rendering in BOTH SettingsPanel and WidgetConfigEditor).
2. **Wave 2 (not started): visual polish + hardening**
   - T1 theme surface alpha ~0.75–0.8 or brightness() in panelBlur (`src/theme/theme.ts:70,100`), then re-shoot light-bg set.
   - T3 WidgetTitle right-slot minWidth:0 / title nowrap.
   - T2 mid-grey strokes: TrackMap outline, Flatmap lap line/ticks, Traffic bar track (Radar pattern).
   - T4 padding unification onto theme.widgetPad/space (list in audit §2).
   - Section 7 per-widget polish (LaunchAssist opacity floor 0.45 + gallery stopped state, SetupComparison empty state, RaceControl honest empty + bottom anchor, TelemetryInspector chrome + scroll fade, TrackMap label declutter <240px, Spotter caption, PitlaneHelper speed marker, Weather vector icons + min clip, Flag checker dark cells, Relative/Standings slack, HighlightedDriver overflow/purple/iRT, FuelSession unit space, Chat height/dot, Radar orientation cue, DashCluster insets, HeartRate balance).
   - Verify with `.claude/skills/visualize-widgets` skill loop (shoot → compare → iterate; use --out/--port per agent if parallel).
   - CSP + fonts: bundle the five Google font families locally (index.html:8-13), then set a strict CSP (tauri.conf.json:46).
3. Deferred/skipped (deliberate): bundle identifier change (user decision), full sync merge/versioning (targeted fix only), audit §8 live-verification items (tc_active, timeRemainingS in practice, WGC resize, sim-exit detection, standings lapped-car ordering), BuyMeACoffee CSP allowance (recheck when CSP lands).
4. Nothing committed yet — user must ask before committing.
