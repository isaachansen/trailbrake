import type { Theme } from "../theme/theme";

/** Theme color keys used for sector performance. */
export type SectorColorKey = "best" | "gain" | "amber" | "loss" | "dim";

/** Default thresholds as fractions of the reference sector time (0.5% / 1.0%). */
const GREEN_FRAC = 0.005;
const YELLOW_FRAC = 0.01;

/**
 * Color a completed (or previous-lap) sector time against a reference split.
 * Purple/best when equal or faster; else green / amber / red by % of ref.
 */
export function sectorColorKey(time: number | null, refTime: number | null): SectorColorKey {
  if (time == null || refTime == null || !(refTime > 0)) return "dim";
  if (time <= refTime) return "best";
  const ratio = (time - refTime) / refTime;
  if (ratio <= GREEN_FRAC) return "gain";
  if (ratio <= YELLOW_FRAC) return "amber";
  return "loss";
}

/**
 * Color a live (or precomputed) delta against a reference split length.
 * Negative/zero delta = ahead = best (purple).
 */
export function sectorColorKeyFromDelta(delta: number | null, refTime: number | null): SectorColorKey {
  if (delta == null || refTime == null || !(refTime > 0)) return "dim";
  if (delta <= 0) return "best";
  const ratio = delta / refTime;
  if (ratio <= GREEN_FRAC) return "gain";
  if (ratio <= YELLOW_FRAC) return "amber";
  return "loss";
}

export function sectorThemeColor(colors: Theme["colors"], key: SectorColorKey): string {
  switch (key) {
    case "best":
      return colors.best;
    case "gain":
      return colors.gain;
    case "amber":
      return colors.amber;
    case "loss":
      return colors.loss;
    default:
      return colors.textDim;
  }
}

/** Canvas stroke with alpha for TrackMap sector arcs. */
export function sectorStrokeColor(colors: Theme["colors"], key: SectorColorKey, alpha = 0.55): string {
  if (key === "dim") return `rgba(255,255,255,${Math.min(alpha, 0.22)})`;
  const hex = sectorThemeColor(colors, key);
  const rgb = hexToRgb(hex);
  if (rgb == null) return hex;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
