// Bake per-car shift-light / rev-light data for the Dash Cluster widget from the
// community "Lovely Car Data" dataset.
//
//   Source : https://github.com/Lovely-Sim-Racing/lovely-car-data
//   License: CC BY-NC-SA 4.0 (NonCommercial + ShareAlike) — see the LICENSE note
//            written into the output. This data is bundled under that license;
//            attribution to Lovely Sim Racing is preserved in the output header.
//
// We take only the **iRacing** subset (simId `iracing`), convert each car's
// per-gear LED RPM thresholds + ARGB colors into a compact runtime shape, and
// write `src/widgets/data/carLeds.json`. The Dash widget matches the live car by
// name at runtime (`src/widgets/carLeds.ts`) and drives its rev lights from this.
//
// Usage:
//   node scripts/fetch-lovely-data.mjs                       # fetch from GitHub (raw)
//   node scripts/fetch-lovely-data.mjs --from-checkout DIR   # read a local clone
//   node scripts/fetch-lovely-data.mjs --refresh             # ignore the cache
//
// A backwards/abbreviated car name that iRacing reports differently from the
// dataset's `carName` can be mapped in `scripts/car-led-overrides.json`:
//   { "<iRacing CarScreenName>": "<lovely carId>" }

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SIM_ID = "iracing";
const RAW_BASE = "https://raw.githubusercontent.com/Lovely-Sim-Racing/lovely-car-data/main/data";
const CACHE_DIR = join(__dirname, ".lovely-car-cache");
const OVERRIDES_PATH = join(__dirname, "car-led-overrides.json");
const OUT_PATH = join(REPO_ROOT, "src", "widgets", "data", "carLeds.json");

const args = process.argv.slice(2);
const fromCheckout = (() => {
  const i = args.indexOf("--from-checkout");
  return i >= 0 ? args[i + 1] : null;
})();
const refresh = args.includes("--refresh");

/** Normalize a car name to a comparison key: lowercase, alphanumeric only. */
function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]/g, "");
}

/** Tokenize a car name for fuzzy matching (lowercased alphanumeric words). */
function tokens(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** ARGB / RGB hex or a few HTML color names → "#rrggbb". */
const NAMED = {
  red: "#ff0000", green: "#00ff00", lime: "#00ff00", blue: "#0000ff",
  yellow: "#ffff00", orange: "#ff8000", white: "#ffffff", cyan: "#00ffff",
  magenta: "#ff00ff", purple: "#b06bff",
};
function toRgb(c) {
  if (!c) return "#ffffff";
  const v = String(c).trim();
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    if (hex.length === 8) return "#" + hex.slice(2).toLowerCase(); // #AARRGGBB → RRGGBB
    if (hex.length === 6) return "#" + hex.toLowerCase();
    if (hex.length === 3) return "#" + hex.split("").map((x) => x + x).join("").toLowerCase();
  }
  return NAMED[v.toLowerCase()] ?? "#ffffff";
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Read manifest + car files from a local checkout dir or from GitHub (cached). */
async function loadIracingCars() {
  if (fromCheckout) {
    const dataDir = join(fromCheckout, "data");
    const manifest = JSON.parse(await readFile(join(dataDir, "manifest.json"), "utf8"));
    const list = manifest.cars?.[SIM_ID] ?? [];
    const out = [];
    for (const entry of list) {
      const raw = JSON.parse(await readFile(join(dataDir, entry.path), "utf8"));
      out.push(raw);
    }
    return out;
  }

  // Fetch from GitHub raw, caching each file so re-bakes are free.
  await mkdir(CACHE_DIR, { recursive: true });
  const manifestCache = join(CACHE_DIR, "manifest.json");
  let manifest;
  if (!refresh && existsSync(manifestCache)) {
    manifest = JSON.parse(await readFile(manifestCache, "utf8"));
  } else {
    manifest = await fetchJson(`${RAW_BASE}/manifest.json`);
    await writeFile(manifestCache, JSON.stringify(manifest));
  }
  const list = manifest.cars?.[SIM_ID] ?? [];
  const out = [];
  for (const entry of list) {
    const cachePath = join(CACHE_DIR, `${SIM_ID}_${entry.carId}.json`);
    let raw;
    if (!refresh && existsSync(cachePath)) {
      raw = JSON.parse(await readFile(cachePath, "utf8"));
    } else {
      raw = await fetchJson(`${RAW_BASE}/${entry.path}`);
      await writeFile(cachePath, JSON.stringify(raw));
    }
    out.push(raw);
  }
  return out;
}

/** Convert one lovely car record → our compact runtime shape. */
function bakeCar(raw) {
  const ledCount = raw.ledNumber ?? (Array.isArray(raw.ledColor) ? raw.ledColor.length - 1 : 0);
  if (!ledCount || !Array.isArray(raw.ledRpm) || !raw.ledRpm[0]) return null;

  // ledColor / per-gear ledRpm are aligned arrays of length ledCount+1, where
  // index 0 is the redline value and 1..ledCount are the individual LEDs.
  const colorArr = Array.isArray(raw.ledColor) ? raw.ledColor.map(toRgb) : [];
  const redlineColor = colorArr[0] ?? "#ff0000";
  const colors = colorArr.slice(1, ledCount + 1);
  while (colors.length < ledCount) colors.push("#ff0000");

  const gears = {};
  for (const [gear, arr] of Object.entries(raw.ledRpm[0])) {
    if (!Array.isArray(arr) || arr.length < ledCount + 1) continue;
    gears[gear] = { redline: arr[0], leds: arr.slice(1, ledCount + 1) };
  }
  if (Object.keys(gears).length === 0) return null;

  return {
    carName: raw.carName?.trim() ?? raw.carId,
    carId: raw.carId,
    carClass: raw.carClass ?? null,
    ledCount,
    blinkIntervalMs: raw.redlineBlinkInterval ?? 250,
    redlineColor,
    colors,
    gears,
  };
}

async function main() {
  const overrides = existsSync(OVERRIDES_PATH)
    ? JSON.parse(await readFile(OVERRIDES_PATH, "utf8"))
    : {};

  const rawCars = await loadIracingCars();
  const cars = rawCars.map(bakeCar).filter(Boolean);
  cars.sort((a, b) => a.carName.localeCompare(b.carName));

  // Aliases: normalized iRacing CarScreenName → lovely carId (from overrides).
  const aliases = {};
  for (const [name, carId] of Object.entries(overrides)) aliases[norm(name)] = carId;

  const payload = {
    _license:
      "Shift-light data derived from Lovely Car Data (github.com/Lovely-Sim-Racing/lovely-car-data), " +
      "licensed CC BY-NC-SA 4.0. NonCommercial + ShareAlike. Bundled with attribution.",
    _source: "lovely-car-data",
    _sim: SIM_ID,
    aliases,
    cars,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Baked ${cars.length} iRacing cars → ${OUT_PATH}`);
  if (Object.keys(aliases).length) console.log(`  + ${Object.keys(aliases).length} name override(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
