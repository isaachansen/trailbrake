// Per-car rev-light / shift-light profiles for the Dash Cluster, baked from the
// community "Lovely Car Data" dataset (CC BY-NC-SA 4.0 — see `_license` in the
// JSON). Regenerate with `npm run fetch-lovely-data`.
//
// At runtime the Dash widget knows the live car only by its display name
// (`slow.carName`, e.g. iRacing's `CarScreenName`), while the dataset is keyed by
// its own `carName` / `carId`. `resolveCarLeds()` matches the two: exact
// normalized name, then carId, then an overrides alias, then a fuzzy token match.
// Unmatched → null, and the widget falls back to its flat `redlineRpm` config.

import data from "./data/carLeds.json";

export interface CarLedGear {
  /** Redline RPM for this gear (pins the bar; LEDs blink at/above it). */
  redline: number;
  /** Per-LED on-thresholds (RPM), length === ledCount. */
  leds: number[];
}

export interface CarLeds {
  carName: string;
  carId: string;
  carClass: string | null;
  ledCount: number;
  blinkIntervalMs: number;
  redlineColor: string;
  /** Per-LED colors "#rrggbb", length === ledCount. */
  colors: string[];
  /** Gear key ("R" / "N" / "1" … ) → thresholds. */
  gears: Record<string, CarLedGear>;
}

interface LedData {
  aliases: Record<string, string>;
  cars: CarLeds[];
}

const ledData = data as unknown as LedData;

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Some real dashes (BMW M4 GT3, Audi R8 LMS EVO2, Mercedes W12/W13, …) have
// physical gap segments in the strip, which the dataset marks with color
// "#000000" and a 0 threshold in every gear. Rendered as permanently-dark
// slots they read as dead pixels on an overlay, so strip them out entirely:
// widgets see only the LEDs that actually light, with colors and per-gear
// thresholds staying index-aligned.
function stripGaps(car: CarLeds): CarLeds {
  const keep: number[] = [];
  for (let i = 0; i < car.colors.length; i++) if (car.colors[i] !== "#000000") keep.push(i);
  if (keep.length === car.colors.length) return car;
  const gears: Record<string, CarLedGear> = {};
  for (const [k, g] of Object.entries(car.gears)) {
    gears[k] = { redline: g.redline, leds: keep.map((i) => g.leds[i]) };
  }
  return { ...car, ledCount: keep.length, colors: keep.map((i) => car.colors[i]), gears };
}

// Indexes built once.
const byKey = new Map<string, CarLeds>();
const byId = new Map<string, CarLeds>();
const tokenIndex: { car: CarLeds; tokens: Set<string> }[] = [];
for (const rawCar of ledData.cars) {
  const car = stripGaps(rawCar);
  byKey.set(norm(car.carName), car);
  byId.set(car.carId, car);
  tokenIndex.push({ car, tokens: new Set(tokenize(car.carName)) });
}

const cache = new Map<string, CarLeds | null>();

/** Resolve a live car name to its rev-light profile, or null if none matches. */
export function resolveCarLeds(carName: string | null | undefined): CarLeds | null {
  if (!carName) return null;
  if (cache.has(carName)) return cache.get(carName) ?? null;

  const n = norm(carName);
  let hit: CarLeds | null =
    byKey.get(n) ??
    byId.get(n) ??
    (ledData.aliases[n] ? byId.get(ledData.aliases[n]) ?? null : null) ??
    null;

  // Fuzzy: best token-set overlap (Jaccard), guarded against weak matches.
  if (!hit) {
    const want = new Set(tokenize(carName));
    if (want.size) {
      let best: CarLeds | null = null;
      let bestScore = 0;
      for (const { car, tokens } of tokenIndex) {
        let shared = 0;
        for (const t of want) if (tokens.has(t)) shared++;
        const union = want.size + tokens.size - shared;
        const score = union ? shared / union : 0;
        if (score > bestScore) {
          bestScore = score;
          best = car;
        }
      }
      // Require a strong overlap so we never guess a wrong car's redline.
      if (best && bestScore >= 0.6) hit = best;
    }
  }

  cache.set(carName, hit);
  return hit;
}

/** Map a numeric gear (−1 = R, 0 = N, 1… ) to the dataset's gear key, with a
 *  sensible fallback to the nearest defined gear. */
export function gearLeds(profile: CarLeds, gear: number | null | undefined): CarLedGear | null {
  const key = gear == null ? "N" : gear < 0 ? "R" : gear === 0 ? "N" : String(gear);
  if (profile.gears[key]) return profile.gears[key];
  // Fall back: highest numbered gear we have (top-gear curve is the safest guess),
  // else any defined gear.
  const numeric = Object.keys(profile.gears)
    .map((k) => Number(k))
    .filter((k) => Number.isFinite(k) && k > 0)
    .sort((a, b) => b - a);
  if (numeric.length) return profile.gears[String(numeric[0])];
  const any = Object.values(profile.gears)[0];
  return any ?? null;
}
