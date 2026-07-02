// Visual lookups for the rich standings/relative rows, ported from the v2 design.
// Flags are CSS gradients (cheap, no image assets); license + tyre are solid swatches.

/** Preset gear-text colors offered by gear widgets (white default + red/yellow/
 *  green), alongside a custom color picker. Shared so the choices don't drift. */
export const GEAR_COLOR_PRESETS: { hex: string; name: string }[] = [
  { hex: "#ffffff", name: "White" },
  { hex: "#ff4d4d", name: "Red" },
  { hex: "#ffd84d", name: "Yellow" },
  { hex: "#3ddc84", name: "Green" },
];

/** Country code → flag gradient. Unknown codes fall back to a neutral swatch. */
export const FLAG: Record<string, string> = {
  FR: "linear-gradient(90deg,#23379b 0 34%,#fff 34% 67%,#e23 67%)",
  DK: "linear-gradient(90deg,#c60c30 0 38%,#fff 38% 56%,#c60c30 56%)",
  IT: "linear-gradient(90deg,#1a8a3f 0 34%,#fff 34% 67%,#cd2b34 67%)",
  GB: "linear-gradient(135deg,#012169 0 40%,#fff 40% 52%,#c8102e 52% 64%,#012169 64%)",
  BE: "linear-gradient(90deg,#1a1a1a 0 34%,#fae042 34% 67%,#ed2939 67%)",
  DE: "linear-gradient(180deg,#1a1a1a 0 34%,#dd0000 34% 67%,#ffce00 67%)",
  NL: "linear-gradient(180deg,#ae1c28 0 34%,#fff 34% 67%,#21468b 67%)",
  ES: "linear-gradient(180deg,#aa151b 0 28%,#f1bf00 28% 72%,#aa151b 72%)",
  SE: "linear-gradient(90deg,#006aa7 0 38%,#fecc00 38% 56%,#006aa7 56%)",
  BR: "linear-gradient(135deg,#009b3a 0 38%,#ffdf00 38% 62%,#009b3a 62%)",
  JP: "radial-gradient(circle at 50% 50%,#bc002d 0 34%,#fff 36%)",
  US: "linear-gradient(180deg,#b22234 0 25%,#fff 25% 50%,#b22234 50% 75%,#3c3b6e 75%)",
};

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

export function flagOf(country: string | null | undefined): string {
  if (!country) return "rgba(255,255,255,0.12)";
  return FLAG[country.toUpperCase()] ?? "rgba(255,255,255,0.12)";
}

/** Split a license string like "A 3.99" into its letter and SR number. */
export function parseLicense(s: string | null | undefined): { letter: string; sr: string } | null {
  if (!s) return null;
  const m = s.trim().match(/^([A-Za-z]+)\s*([\d.]+)?/);
  if (!m) return null;
  return { letter: m[1].toUpperCase(), sr: m[2] ?? "" };
}
