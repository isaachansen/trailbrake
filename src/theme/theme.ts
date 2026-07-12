// Design-system theme contract + packs.
//
// Widgets consume a resolved `Theme` (colors, type, space, glass, list). Adding a
// new look = drop a pack in `packs/` and register it — no widget rewrites.
// Accent from Settings overrides `colors.accent` / player / edit on any pack.

export type ThemeId = "apex" | "graphite";

export interface ThemeColors {
  /** Widget panel fill (glass — translucent, paired with `panelBlur`). */
  surface: string;
  surfaceBorder: string;
  /** Inner stat-cell fill. */
  cell: string;
  /** Player-row / "you" highlight fill (flat token; lists may use accent+alpha). */
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
  gain: string;
  loss: string;
  /** Back-compat alias for the editor accent (== accent). */
  edit: string;
}

export interface ThemeFont {
  /** UI / large numerics. */
  family: string;
  /** Uppercase eyebrow/header/unit labels. */
  label: string;
  /** Telemetry digits (gaps, deltas, lap times, %). */
  mono: string;
  /** Base size in px; widgets scale relative to this. */
  sizeBase: number;
}

/** Liquid / flat panel chrome — used by WidgetHost + self-painting widgets. */
export interface ThemeGlass {
  radius: number;
  /** RGB channels for the dark liquid fill (alpha applied per panel opacity). */
  fillRgb: readonly [number, number, number];
  /** Base fill opacity at panel opacity 1. */
  fillAlpha: number;
  sheenTop: number;
  sheenDiag: number;
  sheenDiagEnd: number;
  border: string;
  shadow: string;
  blur: string;
  /** Specular highlight gradient (absolute overlay). */
  specular: string;
  /** Flat (non-liquid) panel RGB; alpha = user opacity. */
  flatRgb: readonly [number, number, number];
}

/** Shared timing-tower / driver-list metrics (Relative, Standings, …). */
export interface ThemeList {
  rowH: number;
  rowHCompact: number;
  padL: string;
  padR: string;
  colGap: string;
  metaPadL: string;
  trough: string;
  troughShadow: string;
  plate: string;
  plateShadow: string;
  divider: string;
  dividerGlow: string;
  headerBg: string;
  headerShadow: string;
  headerH: string;
  headerLabelSize: string;
  headerTracking: string;
  posChipBg: string;
  /** Player row accent fill alpha over `colors.accent`. */
  playerFillAlpha: number;
}

export interface Theme {
  id: ThemeId;
  name: string;
  colors: ThemeColors;
  font: ThemeFont;
  radius: number;
  /** CSS backdrop-filter for flat glass panels. */
  panelBlur: string;
  panelShadow: string;
  space: { xs: number; sm: number; md: number; lg: number; xl: number };
  widgetPad: string;
  glass: ThemeGlass;
  list: ThemeList;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (full.length !== 6) return null;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(rgb: readonly [number, number, number], a: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/** Apex — current default (Saira + JetBrains, blue accent, liquid-ready glass). */
export const apexTheme: Theme = {
  id: "apex",
  name: "Apex",
  colors: {
    surface: "rgba(18, 20, 27, 0.78)",
    surfaceBorder: "rgba(255, 255, 255, 0.10)",
    cell: "rgba(255, 255, 255, 0.04)",
    playerRow: "rgba(61, 139, 255, 0.16)",
    text: "#eef1f5",
    textDim: "#a8aeb9",
    textDim2: "#828893",
    throttle: "#2fe08a",
    brake: "#ff495e",
    clutch: "#37d4ea",
    steering: "rgba(255, 255, 255, 0.85)",
    gridLine: "rgba(255, 255, 255, 0.06)",
    accent: "#3d8bff",
    best: "#b06bff",
    amber: "#ffb43d",
    gain: "#2fe08a",
    loss: "#ff495e",
    edit: "#3d8bff",
  },
  font: {
    family: '"Saira Condensed", "Segoe UI", system-ui, sans-serif',
    label: '"Saira SemiCondensed", "Saira Condensed", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
    sizeBase: 14,
  },
  radius: 8,
  panelBlur: "blur(20px) saturate(1.25) brightness(0.55)",
  panelShadow: "0 18px 50px rgba(0, 0, 0, 0.5)",
  space: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 },
  widgetPad: "8px 12px",
  glass: {
    radius: 12,
    fillRgb: [13, 15, 21],
    fillAlpha: 0.72,
    sheenTop: 0.045,
    sheenDiag: 0.022,
    sheenDiagEnd: 0.008,
    border: "1px solid rgba(255,255,255,0.14)",
    shadow:
      "0 10px 44px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3), " +
      "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 0 0 1px rgba(255,255,255,0.05), " +
      "inset 0 -10px 28px rgba(255,255,255,0.02)",
    blur: "blur(10px) saturate(150%)",
    specular:
      "radial-gradient(120% 75% at 24% -14%, rgba(255,255,255,0.09), rgba(255,255,255,0.02) 32%, transparent 54%)",
    flatRgb: [18, 20, 27],
  },
  list: {
    rowH: 2.55,
    rowHCompact: 2.15,
    padL: "0",
    padR: "1.2em",
    colGap: "0.45em",
    metaPadL: "0.55em",
    trough: "rgba(0, 0, 0, 0.2)",
    troughShadow: "inset 0 2px 6px rgba(0, 0, 0, 0.45)",
    plate: "rgba(0, 0, 0, 0.28)",
    plateShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.035), inset 0 -1px 0 rgba(0, 0, 0, 0.35)",
    divider: "1px solid rgba(0, 0, 0, 0.72)",
    dividerGlow: "0 1px 0 rgba(255, 255, 255, 0.07)",
    headerBg: "rgba(0, 0, 0, 0.22)",
    headerShadow: "inset 0 -1px 0 rgba(0, 0, 0, 0.55), 0 1px 0 rgba(255, 255, 255, 0.05)",
    headerH: "1.7em",
    headerLabelSize: "0.78em",
    headerTracking: "0.1em",
    posChipBg: "rgba(0,0,0,0.28)",
    playerFillAlpha: 0.32,
  },
};

/** Graphite — cooler neutrals, tighter radius, slightly denser glass. */
export const graphiteTheme: Theme = {
  id: "graphite",
  name: "Graphite",
  colors: {
    surface: "rgba(12, 13, 16, 0.82)",
    surfaceBorder: "rgba(255, 255, 255, 0.08)",
    cell: "rgba(255, 255, 255, 0.035)",
    playerRow: "rgba(120, 160, 200, 0.14)",
    text: "#f2f4f7",
    textDim: "#9aa3b0",
    textDim2: "#6f7885",
    throttle: "#3dd68c",
    brake: "#ff5a6a",
    clutch: "#4ad4e8",
    steering: "rgba(255, 255, 255, 0.88)",
    gridLine: "rgba(255, 255, 255, 0.05)",
    accent: "#7eb6ff",
    best: "#c084fc",
    amber: "#f0b429",
    gain: "#3dd68c",
    loss: "#ff5a6a",
    edit: "#7eb6ff",
  },
  font: {
    family: '"Saira Condensed", "Segoe UI", system-ui, sans-serif',
    label: '"Saira SemiCondensed", "Saira Condensed", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
    sizeBase: 14,
  },
  radius: 6,
  panelBlur: "blur(18px) saturate(1.15) brightness(0.5)",
  panelShadow: "0 16px 44px rgba(0, 0, 0, 0.55)",
  space: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16 },
  widgetPad: "8px 12px",
  glass: {
    radius: 10,
    fillRgb: [10, 11, 14],
    fillAlpha: 0.78,
    sheenTop: 0.03,
    sheenDiag: 0.015,
    sheenDiagEnd: 0.006,
    border: "1px solid rgba(255,255,255,0.10)",
    shadow:
      "0 10px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35), " +
      "inset 0 1px 0 rgba(255,255,255,0.2), inset 0 0 0 1px rgba(255,255,255,0.04), " +
      "inset 0 -10px 24px rgba(255,255,255,0.015)",
    blur: "blur(12px) saturate(130%)",
    specular:
      "radial-gradient(120% 70% at 20% -12%, rgba(255,255,255,0.07), rgba(255,255,255,0.015) 34%, transparent 56%)",
    flatRgb: [12, 13, 16],
  },
  list: {
    ...apexTheme.list,
    trough: "rgba(0, 0, 0, 0.28)",
    plate: "rgba(0, 0, 0, 0.34)",
    headerBg: "rgba(0, 0, 0, 0.28)",
    posChipBg: "rgba(0,0,0,0.34)",
    playerFillAlpha: 0.28,
  },
};

export const THEME_PACKS: Record<ThemeId, Theme> = {
  apex: apexTheme,
  graphite: graphiteTheme,
};

export const THEME_OPTIONS: { id: ThemeId; name: string }[] = [
  { id: "apex", name: apexTheme.name },
  { id: "graphite", name: graphiteTheme.name },
];

export const DEFAULT_THEME_ID: ThemeId = "apex";

/** Back-compat alias — prefer `resolveTheme()` / `useResolvedTheme()`. */
export const defaultTheme: Theme = apexTheme;

/**
 * Resolve a theme pack, optionally overriding the accent (Settings swatch).
 * Widgets should only ever see the result of this — never a half-applied pack.
 */
export function resolveTheme(themeId: ThemeId | string | undefined, accentHex?: string): Theme {
  const base = THEME_PACKS[(themeId as ThemeId) ?? DEFAULT_THEME_ID] ?? apexTheme;
  const accent = typeof accentHex === "string" && /^#[0-9a-fA-F]{6}$/.test(accentHex) ? accentHex : null;
  if (!accent || accent.toLowerCase() === base.colors.accent.toLowerCase()) return base;

  const rgb = hexToRgb(accent);
  if (!rgb) return base;
  return {
    ...base,
    colors: {
      ...base.colors,
      accent,
      edit: accent,
      playerRow: rgba(rgb, 0.16),
    },
  };
}

export function isThemeId(v: unknown): v is ThemeId {
  return v === "apex" || v === "graphite";
}
