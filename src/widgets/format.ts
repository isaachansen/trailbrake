// Small formatting helpers shared by the table-style widgets.

/** Global unit system, chosen in Settings; widgets convert display values to it. */
export type UnitSystem = "metric" | "imperial";

const MS_TO_KMH = 3.6;
const MS_TO_MPH = 2.2369362921;
const L_TO_USGAL = 0.2641720524;

/** Speed: m/s → km/h (metric) or mph (imperial). null passes through. */
export function speedValue(ms: number | null | undefined, u: UnitSystem): number | null {
  if (ms == null || !isFinite(ms)) return null;
  return ms * (u === "imperial" ? MS_TO_MPH : MS_TO_KMH);
}
export function speedLabel(u: UnitSystem): string {
  return u === "imperial" ? "MPH" : "KM/H";
}

/** Fuel: liters → liters (metric) or US gallons (imperial). */
export function fuelValue(l: number | null | undefined, u: UnitSystem): number | null {
  if (l == null || !isFinite(l)) return null;
  return l * (u === "imperial" ? L_TO_USGAL : 1);
}
export function fuelLabel(u: UnitSystem): string {
  return u === "imperial" ? "gal" : "L";
}

/** Temperature: °C → °C (metric) or °F (imperial). */
export function tempValue(c: number | null | undefined, u: UnitSystem): number | null {
  if (c == null || !isFinite(c)) return null;
  return u === "imperial" ? (c * 9) / 5 + 32 : c;
}
export function tempLabel(u: UnitSystem): string {
  return u === "imperial" ? "°F" : "°C";
}

/** Lap time in seconds → "1:29.34" (or "m:ss.hh"); null → "--". */
export function fmtLapTime(s: number | null | undefined): string {
  if (s == null || !isFinite(s) || s <= 0) return "--";
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, "0")}`;
}

/** Signed delta in seconds → "+0.23" / "-1.04"; null → "--". */
export function fmtDelta(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "--";
  return `${s >= 0 ? "+" : ""}${s.toFixed(2)}`;
}

/** Gap in seconds → "1.4" with no sign; null → "--". */
export function fmtGap(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "--";
  return Math.abs(s).toFixed(1);
}

/** 0xRRGGBB int → "#rrggbb". */
export function colorOf(rgb: number | null | undefined, fallback: string): string {
  if (rgb == null) return fallback;
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** "#rrggbb" → "rgba(r,g,b,alpha)". For subtle tints from a palette color. */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 0xRRGGBB int → "rgba(r,g,b,alpha)"; null → `fallback`. For subtle row tints. */
export function rgbaOf(rgb: number | null | undefined, alpha: number, fallback: string): string {
  if (rgb == null) return fallback;
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
