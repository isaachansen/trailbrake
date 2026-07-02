// Central theme tokens. Restyling later is editing these, not hunting through
// components.
//
// Current theme: "APEX OVERLAYS v2" (from the Claude Design handoff) — Saira
// Condensed + JetBrains Mono, a near-black glass look with a pink player accent.

export interface Theme {
  colors: {
    /** Widget panel fill (glass — translucent, paired with `panelBlur`). */
    surface: string;
    surfaceBorder: string;
    /** Inner stat-cell fill. */
    cell: string;
    /** Player-row / "you" highlight fill. */
    playerRow: string;
    text: string;
    textDim: string;
    /** Faintest text (column headers, units). */
    textDim2: string;
    throttle: string;
    brake: string;
    clutch: string;
    steering: string;
    gridLine: string;
    /** Primary accent — player, active controls, edit-mode affordances. */
    accent: string;
    /** Fastest-lap / "best" highlight. */
    best: string;
    amber: string;
    gain: string; // faster / positive
    loss: string; // slower / negative
    /** Back-compat alias for the editor accent (== accent). */
    edit: string;
  };
  font: {
    /** UI / large numerics. */
    family: string;
    /** Uppercase eyebrow/header/unit labels (standings headers, track-map name,
     *  widget titles, unit captions). Wider than the condensed body font so small
     *  tracked-out caps stay legible. */
    label: string;
    /** Telemetry digits (gaps, deltas, lap times, %). */
    mono: string;
    /** Base size in px; widgets scale relative to this. */
    sizeBase: number;
  };
  radius: number;
  /** CSS backdrop-filter for glass panels (the "surface" style). */
  panelBlur: string;
  panelShadow: string;
  // Canonical spacing values widgets should migrate to. Most widgets currently
  // hand-roll their own padding/gaps inline; consume these tokens instead so
  // spacing stays consistent and restylable from one place.
  /** Pixel spacing scale for gaps, margins, and inner padding. */
  space: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
  };
  /** Standard widget outer padding (CSS shorthand). */
  widgetPad: string;
}

const PINK = "#ff2d8e";

export const defaultTheme: Theme = {
  colors: {
    // Raised from 0.55 (was collapsing textDim/textDim2/cell/gridLine over bright
    // backdrops — audit T1). Paired with the brightness() term in `panelBlur` below,
    // self-painted panels (Flag/Spotter/TelemetryInspector, which use this token
    // directly) now land close to the near-solid look WidgetHost's default opacity
    // (1) already gives host-painted panels, instead of washing out independently.
    surface: "rgba(18, 20, 27, 0.78)",
    surfaceBorder: "rgba(255, 255, 255, 0.10)",
    cell: "rgba(255, 255, 255, 0.04)",
    playerRow: "rgba(255, 45, 142, 0.16)",
    text: "#eef1f5",
    // Brightened from #8a909c / #565c68 for legibility: the dim uppercase labels
    // (standings headers, track-map name, unit/eyebrow labels) were too low-contrast
    // in condensed caps. Only the colors moved — sizes/spacing are untouched so
    // layout is unchanged. Hierarchy text > textDim > textDim2 is preserved.
    textDim: "#a8aeb9",
    textDim2: "#828893",
    throttle: "#2fe08a", // green
    brake: "#ff495e", // red
    clutch: "#37d4ea", // cyan
    steering: "rgba(255, 255, 255, 0.85)",
    gridLine: "rgba(255, 255, 255, 0.06)",
    accent: PINK,
    best: "#b06bff", // purple
    amber: "#ffb43d",
    gain: "#2fe08a",
    loss: "#ff495e",
    edit: PINK,
  },
  font: {
    family: '"Saira Condensed", "Segoe UI", system-ui, sans-serif',
    label: '"Saira SemiCondensed", "Saira Condensed", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
    sizeBase: 14,
  },
  radius: 16,
  // `brightness(0.55)` darkens whatever backdrop shows through the glass BEFORE
  // it's blended with `surface`/`cell` colors — this is what actually keeps the
  // floor dark at any panel-opacity setting (opacity only matters once it's < 1;
  // at the default of 1 the panel is fully opaque and this term is a no-op). Fixes
  // audit T1: over bright game footage the old blur+saturate alone let the panel
  // read mid-gray and collapsed textDim/textDim2/cell/gridLine contrast.
  panelBlur: "blur(20px) saturate(1.25) brightness(0.55)",
  panelShadow: "0 18px 50px rgba(0, 0, 0, 0.5)",
  space: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 },
  widgetPad: "8px 12px",
};
