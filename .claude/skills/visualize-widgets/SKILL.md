---
name: visualize-widgets
description: Render every overlay widget to a screenshot and review it visually. Use when asked to see, screenshot, visualize, audit, or improve the UI/look of the widgets or the app — or to verify a widget UI change before/after. Captures PNGs via the gallery route, then evaluates them against a UI rubric.
---

# Visualize & review the overlay widgets

This project's widgets are presentational React components rendered onto a
transparent Tauri overlay. You can't judge how they look by reading the code —
you have to **see them rendered with realistic data**. This skill renders every
widget in isolation, screenshots it, and hands you the images to review.

## How it works (the flow)

1. **Gallery route** — `src/gallery/WidgetGallery.tsx` renders any/all widgets in
   isolation, fed by the same mock telemetry the manager preview uses
   (`startPreviewMock`), inside the exact overlay panel chrome. Reached at
   `?gallery` in browser dev mode.
2. **Capture script** — `scripts/shoot-widgets.mjs` spawns Vite, drives the
   system Chrome headless (via `playwright-core`, no download), and saves a PNG
   per widget plus a contact sheet into `widget-shots/`, with a manifest.
3. **You review** the PNGs with the Read tool and report/fix UI issues.

## Step 1 — Capture

Run from the repo root:

```bash
npm run shoot-widgets                 # all widgets + contact sheet → widget-shots/
npm run shoot-widgets -- --widget=radar          # a single widget
npm run shoot-widgets -- --bg=dark --size=min    # stress contrast / min-size layout
```

Useful flags (pass after `--`):
- `--widget=<id>` — one widget (repeatable). IDs are in `widget-shots/index.json`
  or `src/widgets/registry.ts`.
- `--bg=track|dark|light|checker` — backdrop the glass panels composite over.
  `track` (default) mimics gameplay; `light`/`checker` expose contrast problems.
- `--size=default|min|large` — render at the authored size, the **minimum** size
  (reveals clipping/overflow), or 1.5×.
- `--scale=<n>` / `--opacity=<0..1>` — match a customized instance.
- `--config='{"key":val}'` — override a single widget's config to reach a specific
  state (e.g. a flag color, a different field list).
- `--no-server` — reuse a dev server you already started on `--port` (default 5179).

Output lands in `widget-shots/`: `<id>.png` per widget, `_contact-sheet.png`, and
`index.json` (id, name, file, sizes, capabilities, description).

If capture fails to launch a browser, install Chrome or run
`npx playwright install chromium`.

## Step 2 — Review

Read `widget-shots/index.json` first for the widget list and metadata, then Read
the PNGs.

### Step 2a — Cross-widget consistency pass (MANDATORY, do this FIRST)

**The single most common failure is judging each widget in isolation.** A widget
can look fine alone yet be obviously wrong next to its siblings — one bloated with
empty padding, another with content jammed against the edge, a third clipping.
This is the difference between "looks okay" and "looks designed". You MUST do a
holistic pass before any per-widget work:

1. Read `_contact-sheet.png` — it renders **all** widgets together, to scale.
   (The contact sheet captures the full page; if it ever looks truncated, that's a
   tool bug to fix, not a reason to skip this pass.)
2. Scan across widgets specifically for **spacing/proportion inconsistency**:
   - **Dead space / excess padding** — a widget whose content floats in a too-big
     box with large empty bands (top/bottom/sides) "for no reason".
   - **Zero / edge-touching padding** — content or a bar slammed against a panel
     edge while sibling widgets have a clear inset.
   - **Clipping** — a row/bar cut off at the bottom edge.
   - **Asymmetric pooling** — slack collecting all at the bottom (content pinned to
     top) instead of being balanced or filling.
   - **Inconsistent insets/density** — widgets that should feel like one family
     using visibly different outer padding or row rhythm.
3. List every widget that deviates from the spacing standard below. These are bugs
   even if the widget "looks fine" on its own.

### Step 2b — Per-widget detail

Then open individual shots. For a **thorough audit**, fan out one subagent per
widget — but every subagent MUST be given (a) the spacing standard below and
(b) an instruction to compare its widget against `_contact-sheet.png` and named
sibling widgets, NOT judge it in isolation. Collect findings, dedupe, prioritize.
For a quick look or a single widget, just Read the images yourself.

### Spacing standard (the family rules — enforce these)

- **Outer padding**: every panel widget's root container uses `theme.widgetPad`
  (or a value within ±2px of it). No widget gets zero vertical padding — content
  must never touch a panel edge. (Exceptions: full-bleed canvas widgets that draw
  edge-to-edge — Radar, TrackMap, Flatmap — and `transparentPanel` screen effects.)
- **Gaps**: use the `theme.space` scale (xs/sm/md/lg/xl) for gaps and inner
  padding, not hand-rolled magic numbers.
- **Fill, don't float**: content should fill the panel or be balanced. If content
  is shorter than the box, either `justify-content: center` (balanced top/bottom)
  or right-size the widget's `defaultSize` to the content — never leave a large
  dead band or pin content to the top so slack pools at the bottom.
- **Default size matches content**: pick `defaultSize` so the authored content
  sits comfortably with consistent padding — not so tall it floats, not so short
  it clips. (Beware: internal `overflow:hidden` + `flex:1` regions defeat
  `FitContent`'s shrink-to-fit, so under-sized boxes clip instead of scaling —
  size the default correctly.)
- **Consistency beats local cleverness**: when in doubt, match what the sibling
  widgets do (corner radius `theme.radius`, header style, label casing, density).

### UI rubric — judge each widget on:

- **Legibility** — is every value readable at this size? Any text too small,
  low-contrast, or crushed? Check against `--bg=light` too.
- **Clipping / overflow** — anything cut off, truncated, or spilling the panel?
  Re-shoot at `--size=min` to confirm it degrades gracefully.
- **Alignment & spacing** — columns aligned, consistent padding/gaps, no awkward
  gaps or crowding. Numbers should be monospaced and right-aligned where compared.
- **Visual hierarchy** — does the most important value stand out? Is the player /
  "you" row clearly distinguished? Are dim labels actually secondary?
- **Color usage** — consistent with the theme tokens (`src/theme/theme.ts`):
  green = gain/throttle, red = loss/brake, pink accent = player. No clashing or
  meaningless color.
- **Consistency** — does it match the look of sibling widgets (corner radius,
  header style, label casing, density)?
- **Honest empty/edge states** — the project never fakes data. If a field has no
  value it should be absent or a clear placeholder, not a zero.
- **Density & balance** — does the content fill the panel sensibly, or is there
  dead space / an over-stuffed corner?

When reporting, cite the widget id and the specific shot, describe the issue
concretely, and propose a concrete fix (which file, what change). The widget
component is `src/widgets/<Name>.tsx`.

## Step 3 — Iterate (visual diff)

To verify a UI change:
1. Capture the baseline: `npm run shoot-widgets -- --widget=<id>` and note it.
2. Edit the widget component in `src/widgets/`.
3. Re-capture the same widget and Read both the old and new PNG to compare.
4. Repeat until the rubric is satisfied. Re-run at `--size=min` and `--bg=light`
   before declaring it done.

## Notes

- Mock data lives in `src/store/mockSource.ts` (and the rejoin scenario in
  `src/manager/previewStore.ts`). To exercise a state the hot-lap mock never
  reaches, either add a scenario store there or use `--config=`.
- `widget-shots/` is gitignored — it's a regenerable scratch output.
- Some widgets paint a transparent/full-screen effect (e.g. Flag, Spotter glow);
  the contact sheet draws a dashed guide around their bounds. Use `--bg=track`
  to see screen effects against a realistic scene.
