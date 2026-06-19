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
    /** UI / labels / large numerics. */
    family: string;
    /** Telemetry digits (gaps, deltas, lap times, %). */
    mono: string;
    /** Base size in px; widgets scale relative to this. */
    sizeBase: number;
  };
  radius: number;
  /** CSS backdrop-filter for glass panels (the "surface" style). */
  panelBlur: string;
  panelShadow: string;
}

const PINK = "#ff2d8e";

export const defaultTheme: Theme = {
  colors: {
    surface: "rgba(18, 20, 27, 0.55)",
    surfaceBorder: "rgba(255, 255, 255, 0.10)",
    cell: "rgba(255, 255, 255, 0.04)",
    playerRow: "rgba(255, 45, 142, 0.16)",
    text: "#eef1f5",
    textDim: "#8a909c",
    textDim2: "#565c68",
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
    mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
    sizeBase: 14,
  },
  radius: 16,
  panelBlur: "blur(20px) saturate(1.25)",
  panelShadow: "0 18px 50px rgba(0, 0, 0, 0.5)",
};
