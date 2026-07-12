// Visual lookups for the rich standings/relative rows, ported from the v2 design.
// License + tyre are solid swatches. Country flags use flag-icons (see FlagSwatch).

/** Preset gear-text colors offered by gear widgets (white default + red/yellow/
 *  green), alongside a custom color picker. Shared so the choices don't drift. */
export const GEAR_COLOR_PRESETS: { hex: string; name: string }[] = [
  { hex: "#ffffff", name: "White" },
  { hex: "#ff4d4d", name: "Red" },
  { hex: "#ffd84d", name: "Yellow" },
  { hex: "#3ddc84", name: "Green" },
];

/** License class letter → badge color. */
export const LIC: Record<string, string> = {
  P: "#b06bff",
  A: "#3d8bff",
  B: "#2fe08a",
  C: "#ffd23d",
  D: "#ff9d3d",
  R: "#fb4b4b", // Rookie — iRacing red

};

/** Tyre compound code → color. Specific compounds (Soft/Medium/Hard/Wet) plus a
 * generic Dry (gray) for sims that only report dry-vs-wet, not the compound. */
export const TYRE: Record<string, string> = {
  S: "#ff495e",
  M: "#ffd23d",
  H: "#e7ebf2",
  W: "#3d8bff", // wet
  D: "#8a8f99", // dry, compound unknown
};

// Our class palette — blue / purple / green / red (then cyan), assigned by class
// order. We deliberately override whatever color the sim reports so multiclass
// fields always read in the app's palette (no yellow / teal).
export const CLASS_PALETTE = ["#3d8bff", "#b06bff", "#2fe08a", "#ff495e", "#37d4ea"];

/**
 * Map each class id → a palette color, ordered fastest class first (by best lap),
 * so the quickest class is always blue, the next purple, etc. Cars with no class
 * id fall into one bucket (single-class → blue). Compute once from the full field
 * and share across widgets so a class is the same color everywhere.
 */
export function classColorMap(cars: { carClassId: number | null; bestLapS: number | null }[]): Map<number, string> {
  const best = new Map<number, number>();
  for (const c of cars) {
    const id = c.carClassId ?? -1;
    const b = c.bestLapS ?? Infinity;
    const cur = best.get(id);
    if (cur == null || b < cur) best.set(id, b);
  }
  // Deterministic order even when laps are missing: classes with no best lap
  // (Infinity) compare equal, and equal bests tiebreak by class id — so the
  // assignment can't flap between updates or differ across widgets.
  const ids = [...best.keys()].sort((a, b) => {
    const ba = best.get(a)!;
    const bb = best.get(b)!;
    if (ba === bb || (ba === Infinity && bb === Infinity)) return a - b;
    return ba - bb;
  });
  const map = new Map<number, string>();
  ids.forEach((id, i) => map.set(id, CLASS_PALETTE[i % CLASS_PALETTE.length]));
  return map;
}

/** Palette color for a class id (falls back to the first palette color). */
export function classColorOf(map: Map<number, string>, classId: number | null | undefined): string {
  return map.get(classId ?? -1) ?? CLASS_PALETTE[0];
}

/** Split a license string like "A 3.99" into its letter and SR number. */
export function parseLicense(s: string | null | undefined): { letter: string; sr: string } | null {
  if (!s) return null;
  const m = s.trim().match(/^([A-Za-z]+)\s*([\d.]+)?/);
  if (!m) return null;
  return { letter: m[1].toUpperCase(), sr: m[2] ?? "" };
}
