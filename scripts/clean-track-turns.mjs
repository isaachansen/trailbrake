// Offline cleanup for baked corner markers.
//
// The `--from-dataset` bake derives corner markers from a third-party dataset's
// `normalizedTurns`, which over-counts real corners (multiple entry/apex/exit
// markers per corner) and occasionally drops a marker out in the runoff — e.g.
// Red Bull Ring bakes 16 markers for a 10-corner track. This pass operates on
// the already-baked bundle (no iRacing access): for each track it clusters the
// markers by lap position, discards off-the-racing-line outliers, collapses each
// cluster to one marker, and renumbers 1..N in driving order.
//
//   node scripts/clean-track-turns.mjs            # rewrite the bundle in place
//   node scripts/clean-track-turns.mjs --dry-run  # report only, no write

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(REPO, "crates", "iracing-connector", "assets", "track_maps.json");

// Markers closer than this in lap fraction belong to the same corner. A real
// chicane's two numbered corners are normally farther apart than this.
const MERGE_FRAC = 0.025;
// A cluster member this far off the centerline is a runoff/outlier marker and is
// dropped when positioning the corner (unless every member is an outlier).
const OUTLIER_DIST = 0.06;

const round = (v) => Math.round(v * 1e5) / 1e5;

// Lap fraction (0..1) and distance-to-line for a marker, using the baked points
// (index i ≈ fraction i/N — the same mapping the widget uses to place cars).
function locate(points, x, y) {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i][0] - x;
    const dy = points[i][1] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return { frac: bi / points.length, dist: Math.sqrt(bd) };
}

export function cleanTurns(points, turns) {
  if (!Array.isArray(points) || points.length < 3 || !Array.isArray(turns) || !turns.length) {
    return turns ?? [];
  }
  const ann = turns
    .filter((t) => t && Number.isFinite(t.x) && Number.isFinite(t.y))
    .map((t) => ({ ...t, ...locate(points, t.x, t.y) }))
    .sort((a, b) => a.frac - b.frac);

  // Cluster consecutive markers whose lap-fraction gap is below the threshold.
  const clusters = [];
  for (const t of ann) {
    const last = clusters[clusters.length - 1];
    if (last && t.frac - last[last.length - 1].frac < MERGE_FRAC) last.push(t);
    else clusters.push([t]);
  }

  // Collapse each cluster: average the on-line members (drop runoff outliers),
  // then renumber by driving order.
  return clusters
    .map((c) => {
      const kept = c.filter((t) => t.dist <= OUTLIER_DIST);
      const use = kept.length ? kept : c;
      const x = use.reduce((s, t) => s + t.x, 0) / use.length;
      const y = use.reduce((s, t) => s + t.y, 0) / use.length;
      const frac = use.reduce((s, t) => s + t.frac, 0) / use.length;
      return { x, y, frac };
    })
    .sort((a, b) => a.frac - b.frac)
    .map((t, i) => ({ label: String(i + 1), x: round(t.x), y: round(t.y) }));
}

// --- run as a script (skip when imported) ------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dry = process.argv.includes("--dry-run");
  const bundle = JSON.parse(readFileSync(FILE, "utf8"));
  let changed = 0;
  let total = 0;
  for (const [, track] of Object.entries(bundle)) {
    if (!Array.isArray(track.turns) || !track.turns.length) continue;
    total++;
    const before = track.turns.length;
    const cleaned = cleanTurns(track.points, track.turns);
    if (cleaned.length !== before) changed++;
    if (/red bull/i.test(track.name || "")) {
      console.log(`Red Bull Ring (${track.name}): ${before} -> ${cleaned.length} corners`);
      console.log("  ", cleaned.map((t) => `${t.label}@(${t.x},${t.y})`).join("  "));
    }
    track.turns = cleaned;
  }
  console.log(`\nTracks with turns: ${total}; turn-count changed on ${changed}.`);
  if (dry) {
    console.log("--dry-run: not writing.");
  } else {
    copyFileSync(FILE, FILE + ".bak");
    const keys = Object.keys(bundle).sort((a, b) => Number(a) - Number(b));
    const ordered = {};
    for (const k of keys) ordered[k] = bundle[k];
    writeFileSync(FILE, JSON.stringify(ordered) + "\n");
    console.log(`Wrote ${FILE} (backup at track_maps.json.bak).`);
  }
}
