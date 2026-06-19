// Fetches corner names, sectors, and pit markers from the community-maintained
// lovely-track-data repo (CC BY-NC-SA 4.0) and merges them into the baked
// track_maps.json as a per-track `metadata` field.
//
// Run AFTER fetch-track-maps.mjs (needs track_maps.json with populated names):
//   npm run fetch-track-maps        # bakes geometry + names from iRacing API
//   npm run fetch-lovely-track-data # merges lovely metadata into track_maps.json
//
// No iRacing credentials needed — lovely-track-data is public on GitHub.
// Raw lovely JSONs are cached under scripts/.lovely-cache/ so re-runs are free.
//
// Manual name-match fixes live in scripts/lovely-id-map.json, keyed by iRacing
// numeric track id → lovely path (e.g. "iracing/imola-gp.json"):
//   { "18": "iracing/imola-gp.json" }
//
// The auto-matcher uses lovely's `trackId` field (SimHub-style cleaned name,
// e.g. "imola gp") split into a track key + config key, matched against
// iRacing's trackName + configName with substring matching and abbreviation
// expansion ("grand prix" → "gp"). Unmatched tracks are logged and get no
// metadata — non-fatal; the widget falls back to plain corner numbers.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const TRACK_MAPS = join(REPO, "crates", "iracing-connector", "assets", "track_maps.json");
const CACHE_DIR = join(HERE, ".lovely-cache");
const ID_MAP = join(HERE, "lovely-id-map.json");
const MANIFEST_URL = "https://raw.githubusercontent.com/Lovely-Sim-Racing/lovely-track-data/main/data/manifest.json";
const RAW_BASE = "https://raw.githubusercontent.com/Lovely-Sim-Racing/lovely-track-data/main/data/";

const flags = new Set(process.argv.slice(2));
const REFRESH = flags.has("--refresh");

// --- helpers -----------------------------------------------------------------

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function normalize(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// iRacing uses "Grand Prix" but lovely uses "gp"; expand abbreviations before
// normalizing so both sides speak the same language.
const CONFIG_ABBREVS = [
  [/\bgrand prix\b/gi, "gp"],
];

function normalizeConfig(s) {
  if (!s) return "";
  let out = s;
  for (const [re, rep] of CONFIG_ABBREVS) out = out.replace(re, rep);
  return normalize(out);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// --- matching ----------------------------------------------------------------

// Build a lookup from the lovely manifest: for each iracing entry, parse the
// trackId ("imola gp") into a trackKey ("imola") and configKey ("gp"). The
// trackKey is used for fuzzy name matching; the configKey disambiguates configs.
function buildLovelyLookup(manifest) {
  const entries = manifest.tracks?.iracing ?? [];
  return entries.map((e) => {
    const parts = (e.trackId || "").split(/\s+/);
    const trackKey = normalize(parts[0]);
    const configKey = normalize(parts.slice(1).join(" "));
    return { ...e, trackKey, configKey };
  });
}

// Find the best lovely match for an iRacing track by name + config.
// Returns the lovely entry's `path` (e.g. "iracing/imola-gp.json") or null.
function matchLovely(lookup, irName, irConfig) {
  if (!irName) return null;
  const irTrack = normalize(irName);
  const irConfigNorm = normalizeConfig(irConfig);

  // Stage 1: find candidates where the lovely trackKey matches the iRacing
  // trackName (substring either way — handles "Imola" vs "Imola" exact, and
  // "Hockenheimring Baden-Württemberg" containing "hockenheim").
  const candidates = lookup.filter((e) => {
    if (!e.trackKey) return false;
    return irTrack.includes(e.trackKey) || e.trackKey.includes(irTrack);
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].path;

  // Stage 2: disambiguate by config. Prefer an exact config match, then a
  // substring match. If iRacing has no config, prefer the lovely entry with
  // no configKey (the "base" layout).
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    if (!irConfigNorm && !c.configKey) {
      score = 3; // both have no config — strong match
    } else if (irConfigNorm && c.configKey) {
      if (irConfigNorm === c.configKey) score = 5;
      else if (irConfigNorm.includes(c.configKey) || c.configKey.includes(irConfigNorm)) score = 4;
    } else if (!irConfigNorm && c.configKey) {
      score = 1; // iRacing has no config but lovely does — weak
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 3 ? best.path : null;
}

// --- metadata extraction -----------------------------------------------------

function extractMetadata(lovely) {
  const md = {};
  if (lovely.country) md.country = lovely.country;
  if (lovely.length) md.length = lovely.length;
  if (lovely.pitentry != null) md.pitEntry = lovely.pitentry;
  if (lovely.pitexit != null) md.pitExit = lovely.pitexit;
  if (Array.isArray(lovely.sector) && lovely.sector.length) {
    md.sectors = lovely.sector.map((s) => ({ name: s.name, marker: s.marker }));
  }
  if (Array.isArray(lovely.turn) && lovely.turn.length) {
    md.lovelyTurns = lovely.turn.map((t) => ({
      name: t.name,
      marker: t.marker,
      start: t.start,
      end: t.end,
    }));
  }
  return Object.keys(md).length ? md : null;
}

// --- main --------------------------------------------------------------------

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  // 1. Load the baked track_maps.json (id → { name, config, points, turns }).
  const baked = readJson(TRACK_MAPS, null);
  if (!baked || typeof baked !== "object") {
    console.error(`Could not read ${TRACK_MAPS}. Run fetch-track-maps first.`);
    process.exit(1);
  }
  const ids = Object.keys(baked);
  const named = ids.filter((k) => baked[k].name);
  console.log(`Loaded ${ids.length} baked tracks (${named.length} with names, ${ids.length - named.length} unnamed).`);
  if (named.length === 0) {
    console.warn("No tracks have names — re-bake with `npm run fetch-track-maps` (iRacing auth) to populate names first.");
    console.warn("Skipping lovely metadata merge (non-fatal).");
    return;
  }

  // 2. Fetch the lovely manifest.
  console.log("Fetching lovely-track-data manifest...");
  const manifest = await fetchJson(MANIFEST_URL);
  const lookup = buildLovelyLookup(manifest);
  console.log(`Manifest has ${lookup.length} iRacing tracks.`);

  // 3. Load the override map (manual id → lovely path fixes).
  const overrideMap = readJson(ID_MAP, {});

  // 4. For each named track, find its lovely match and fetch metadata.
  let matched = 0;
  let unmatched = 0;
  const unmatchedLog = [];
  for (const id of ids) {
    const track = baked[id];
    if (!track.name) continue;

    // Override map takes priority.
    let path = overrideMap[id];
    let matchSource = "override";

    // Auto-match if no override.
    if (!path) {
      path = matchLovely(lookup, track.name, track.config);
      matchSource = path ? "auto" : "none";
    }

    if (!path) {
      unmatched++;
      unmatchedLog.push(`  ${id}  ${track.name}${track.config ? " / " + track.config : ""}`);
      continue;
    }

    // Fetch the lovely JSON (cache it for re-runs).
    const cacheFile = join(CACHE_DIR, path.replace(/\//g, "_"));
    let lovely;
    if (!REFRESH && existsSync(cacheFile)) {
      lovely = readJson(cacheFile, null);
    } else {
      try {
        lovely = await fetchJson(RAW_BASE + encodeURI(path));
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(lovely));
      } catch (e) {
        unmatched++;
        unmatchedLog.push(`  ${id}  ${track.name} — fetch failed: ${e.message}`);
        continue;
      }
    }

    const metadata = extractMetadata(lovely);
    if (metadata) {
      baked[id].metadata = metadata;
      matched++;
    } else {
      unmatched++;
    }
  }

  console.log(`\nMatched ${matched}, unmatched ${unmatched}.`);
  if (unmatchedLog.length) {
    console.log("Unmatched tracks (no metadata — widget falls back to corner numbers):");
    for (const line of unmatchedLog.slice(0, 30)) console.log(line);
    if (unmatchedLog.length > 30) console.log(`  ... and ${unmatchedLog.length - 30} more`);
    console.log(`\nTo fix a mismatch, add an entry to scripts/lovely-id-map.json:`);
    console.log(`  { "<trackId>": "iracing/<lovely-filename>.json" }`);
  }

  // 5. Write the enriched track_maps.json.
  writeFileSync(TRACK_MAPS, JSON.stringify(baked) + "\n");
  console.log(`\nWrote enriched track_maps.json -> ${TRACK_MAPS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
