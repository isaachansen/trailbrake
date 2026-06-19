// Clean-room fetch + bake of iRacing's official track maps into a lookup table
// the connector compiles in (crates/iracing-connector/assets/track_maps.json).
//
// We use iRacing's OWN published track-map SVGs — the same vector layers the
// membersite renders — fetched via the `iracing-api` client. No code or data
// from any third-party overlay project is used; iRaceHUD was consulted only for
// the conceptual approach (active layer = centerline, separate S/F + turns
// layers), never copied.
//
// Pipeline per track:
//   1. fetch the ACTIVE layer SVG   -> the track centerline path `d`
//   2. fetch the START/FINISH SVG   -> a representative S/F point (centroid)
//   3. fetch the TURNS layer (opt)  -> Turn 1 position, to infer direction
//   4. sample N points evenly by arc length along the centerline
//   5. rotate so the point nearest S/F becomes index 0  (=> array order == lapDistPct)
//   6. reverse if the driving direction runs opposite the SVG path order
//   7. normalize the bounding box into 0..1, preserving aspect ratio (SVG y-down)
//
// Raw fetched geometry is cached under scripts/.track-map-cache/<id>.json so a
// re-bake (e.g. after editing a direction override) needs NO login:
//
//   npm run fetch-track-maps               # login, fetch (uses cache), bake, write
//   npm run fetch-track-maps -- --refresh  # ignore cache, re-fetch every track
//   npm run fetch-track-maps -- --rebake   # NO login: re-bake from cache only
//
// Manual fixes live in scripts/track-map-overrides.json, keyed by track id:
//   { "18": { "direction": -1 } }
//
// Env: IRACING_LOGIN (account email) and IRACING_PWD (password).

import { svgPathProperties } from "svg-path-properties";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SAMPLES = 400;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CACHE_DIR = join(HERE, ".track-map-cache");
const OVERRIDES = join(HERE, "track-map-overrides.json");
const DATA_DIR = join(HERE, "iracing-data");
const DATASET = process.env.TRACKS_DATASET || join(REPO, "assets", "tracks.json");
const OUT = join(REPO, "crates", "iracing-connector", "assets", "track_maps.json");

const flags = new Set(process.argv.slice(2));
const REBAKE_ONLY = flags.has("--rebake");
const REFRESH = flags.has("--refresh");
const OFFLINE = flags.has("--offline");
const FROM_DATASET = flags.has("--from-dataset");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// The iRacing data API returns snake/kebab-case keys; the `iracing-api` client
// camelizes them, so for --offline (browser-saved) data we do the same, matching
// the field names the rest of the script expects (trackMap, startFinish, ...).
function camelize(s) {
  return s.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
}
function camelizeKeys(v) {
  if (Array.isArray(v)) return v.map(camelizeKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[camelize(k)] = camelizeKeys(val);
    return out;
  }
  return v;
}

// Load a browser-saved data file. iRacing data endpoints return either the final
// payload or a `{ link }` wrapper pointing at a (public, presigned) S3 URL — we
// follow the link when present, then camelize keys.
async function loadOffline(file, label) {
  const j = readJson(file, null);
  if (j == null) throw new Error(`missing or invalid ${label} file: ${file}`);
  if (typeof j.link === "string") {
    const res = await fetch(j.link);
    if (!res.ok) {
      throw new Error(`following the link in ${file} returned ${res.status} — the presigned URL likely expired; re-save it and retry promptly`);
    }
    return camelizeKeys(await res.json());
  }
  return camelizeKeys(j);
}

// --- SVG helpers (regex-based; the layers are simple, no DOM needed) ---------

function extractPathDs(svg) {
  const out = [];
  const re = /\bd\s*=\s*(["'])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(svg))) out.push(m[2]);
  return out;
}

// The active layer's centerline is the longest path in the file (pit lane and
// other strokes, when present, are shorter or live in separate layers).
function longestPath(svg) {
  let best = null;
  let bestLen = -1;
  for (const d of extractPathDs(svg)) {
    try {
      const len = new svgPathProperties(d).getTotalLength();
      if (len > bestLen) {
        bestLen = len;
        best = d;
      }
    } catch {
      // Unparseable fragment; skip it.
    }
  }
  return best;
}

// A representative point for the start/finish layer: the centroid of every
// coordinate we can pull from it (path samples + line / circle anchors). It is
// in the same SVG coordinate space as the active layer, so the nearest sampled
// centerline point to this centroid is the real start/finish position.
function centroidOf(svg) {
  const pts = [];
  for (const d of extractPathDs(svg)) {
    try {
      const p = new svgPathProperties(d);
      const total = p.getTotalLength();
      const n = 24;
      for (let i = 0; i < n; i++) {
        const q = p.getPointAtLength((i / n) * total);
        pts.push([q.x, q.y]);
      }
    } catch {
      // skip
    }
  }
  const num = (s) => parseFloat(s);
  let m;
  const lineRe =
    /<line\b[^>]*\bx1\s*=\s*["']([^"']+)["'][^>]*\by1\s*=\s*["']([^"']+)["'][^>]*\bx2\s*=\s*["']([^"']+)["'][^>]*\by2\s*=\s*["']([^"']+)["']/g;
  while ((m = lineRe.exec(svg))) {
    pts.push([num(m[1]), num(m[2])]);
    pts.push([num(m[3]), num(m[4])]);
  }
  const circRe = /<(?:circle|ellipse)\b[^>]*\bcx\s*=\s*["']([^"']+)["'][^>]*\bcy\s*=\s*["']([^"']+)["']/g;
  while ((m = circRe.exec(svg))) pts.push([num(m[1]), num(m[2])]);

  if (!pts.length) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  return [sx / pts.length, sy / pts.length];
}

// Best-effort Turn 1 position from the turns layer, used only to infer driving
// direction. Returns null when it can't be parsed (then we default to +1).
function turnOnePoint(svg) {
  if (!svg) return null;
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(svg))) {
    const attrs = m[1];
    const label = m[2].replace(/<[^>]*>/g, "").trim();
    if (label !== "1") continue;
    const xa = /\bx\s*=\s*["']([-\d.]+)["']/.exec(attrs);
    const ya = /\by\s*=\s*["']([-\d.]+)["']/.exec(attrs);
    if (xa && ya) return [parseFloat(xa[1]), parseFloat(ya[1])];
    const tr = /translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/.exec(attrs);
    if (tr) return [parseFloat(tr[1]), parseFloat(tr[2])];
  }
  return null;
}

function nearestIndex(pts, pt) {
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - pt[0];
    const dy = pts[i][1] - pt[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      idx = i;
    }
  }
  return idx;
}

// Turn the raw centerline `d` (+ S/F point, + Turn 1) into a normalized,
// S/F-anchored, driving-direction-ordered, aspect-preserved closed loop.
function bake(raw, override) {
  const { activeD, sfPoint, turn1 } = raw;
  const props = new svgPathProperties(activeD);
  const total = props.getTotalLength();

  let pts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const p = props.getPointAtLength((i / SAMPLES) * total);
    pts.push([p.x, p.y]);
  }

  // Rotate so the point nearest the S/F line is index 0 (lapDistPct 0).
  const sfIdx = sfPoint ? nearestIndex(pts, sfPoint) : 0;
  pts = pts.slice(sfIdx).concat(pts.slice(0, sfIdx));

  // Driving direction: explicit override wins. Otherwise infer from Turn 1 — it
  // sits just after S/F, so its nearest index should fall in the first half of
  // the lap; if it lands in the second half the SVG path runs backwards.
  let direction = override?.direction;
  if (direction == null && turn1) {
    direction = nearestIndex(pts, turn1) > SAMPLES / 2 ? -1 : 1;
  }
  if (direction == null) direction = 1;
  // Reverse the order but keep the S/F point pinned at index 0.
  if (direction === -1) pts = [pts[0], ...pts.slice(1).reverse()];

  // Normalize into a 0..1 box, aspect-preserved, y-down (the widget renders
  // y-down, so no flip).
  return normalizeAspect(pts);
}

// Compute the uniform (aspect-preserving) transform that maps a set of points
// into a 0..1 box, centering the shorter axis. Returns a `map([x,y]) -> [x,y]`
// closure so the same transform can be applied to other points (e.g. turns).
function aspectTransform(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const offX = (span - (maxX - minX)) / 2;
  const offY = (span - (maxY - minY)) / 2;
  const round = (v) => Math.round(v * 1e5) / 1e5;
  return ([x, y]) => [round((x - minX + offX) / span), round((y - minY + offY) / span)];
}

// Re-normalize points into a 0..1 box, aspect-preserved, y-down.
function normalizeAspect(pts) {
  return pts.map(aspectTransform(pts));
}

// Bake one entry of a pre-sampled dataset (assets/tracks.json: per track a
// `sampledPoints` array of { pct, x, y } already aspect-normalized, plus
// `sfOffsetPct` and `pathReversed`). Produces our index-0-at-S/F,
// driving-direction, 0..1 closed loop — no SVG sampling needed.
function bakeFromSampled(entry, override) {
  const sp = entry.sampledPoints;
  if (!Array.isArray(sp) || sp.length < 3) throw new Error("no sampledPoints");
  let pts = sp.map((p) => [p.x, p.y]);

  // Rotate so the point nearest the start/finish (sfOffsetPct along the lap) is
  // index 0. `pct` is monotonic 0..1, so pick the closest.
  const sfPct = typeof entry.sfOffsetPct === "number" ? entry.sfOffsetPct : 0;
  let sfIdx = 0;
  let best = Infinity;
  for (let i = 0; i < sp.length; i++) {
    const d = Math.abs((sp[i].pct ?? i / sp.length) - sfPct);
    if (d < best) {
      best = d;
      sfIdx = i;
    }
  }
  pts = pts.slice(sfIdx).concat(pts.slice(0, sfIdx));

  // Direction: an explicit override wins; otherwise honor the dataset's flag.
  // (Reversal only reorders points, so it doesn't move the turn markers.)
  const reversed = override?.direction != null ? override.direction === -1 : !!entry.pathReversed;
  if (reversed) pts = [pts[0], ...pts.slice(1).reverse()];

  // One transform shared by the centerline and the corner markers so they stay
  // aligned in the baked 0..1 space.
  const t = aspectTransform(pts);
  const points = pts.map(t);
  // Corner labels. The dataset's own `number`/`name` assignment is unreliable
  // (numbers don't run sequentially around the lap), so ignore it and re-number
  // the markers by their actual position along the driving direction, starting
  // at the start/finish line. `dir` is the sign of pct change in the driving
  // direction: +1 normally, -1 when the path is reversed.
  let turns = [];
  if (Array.isArray(entry.normalizedTurns) && entry.normalizedTurns.length) {
    const pctOf = (tx, ty) => {
      let bestD = Infinity;
      let bestPct = 0;
      for (const p of sp) {
        const d = (p.x - tx) ** 2 + (p.y - ty) ** 2;
        if (d < bestD) {
          bestD = d;
          bestPct = p.pct ?? 0;
        }
      }
      return bestPct;
    };
    const dir = reversed ? -1 : 1;
    // Lap fraction from S/F in the driving direction, 0..1.
    const fromSF = (pct) => (((dir * (pct - sfPct)) % 1) + 1) % 1;
    turns = entry.normalizedTurns
      .map((tn) => ({ d: fromSF(pctOf(tn.x, tn.y)), p: t([tn.x, tn.y]) }))
      .sort((a, b) => a.d - b.d)
      .map((tn, i) => ({ label: String(i + 1), x: tn.p[0], y: tn.p[1] }));
  }
  return { points, turns };
}

// --- fetching ----------------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function fetchRaw(asset) {
  const base = asset.trackMap;
  const layers = asset.trackMapLayers || {};
  const activeSvg = layers.active ? await fetchText(base + layers.active) : null;
  const sfSvg = layers.startFinish ? await fetchText(base + layers.startFinish) : null;
  let turnsSvg = null;
  if (layers.turns) {
    try {
      turnsSvg = await fetchText(base + layers.turns);
    } catch {
      // Turns layer is optional; absence just means we fall back to +1.
    }
  }
  return {
    activeD: activeSvg ? longestPath(activeSvg) : null,
    sfPoint: sfSvg ? centroidOf(sfSvg) : null,
    turn1: turnOnePoint(turnsSvg),
  };
}

function writeOut(out) {
  const keys = Object.keys(out).sort((a, b) => Number(a) - Number(b));
  const ordered = {};
  for (const k of keys) ordered[k] = out[k];
  writeFileSync(OUT, JSON.stringify(ordered) + "\n");
  console.log(`Wrote ${keys.length} tracks -> ${OUT}`);
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });
  const overrides = readJson(OVERRIDES, {});
  const out = {};

  // --rebake: bake straight from the cache, no network, no credentials.
  if (REBAKE_ONLY) {
    const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
    console.log(`Re-baking ${files.length} cached track(s), no login.`);
    for (const f of files) {
      const cached = readJson(join(CACHE_DIR, f), null);
      if (!cached?.activeD) continue;
      try {
        const points = bake(cached, overrides[String(cached.trackId)]);
        out[String(cached.trackId)] = { name: cached.name, config: cached.config ?? null, points };
      } catch (e) {
        console.warn(`  skip ${cached.trackId} ${cached.name}: ${e.message}`);
      }
    }
    writeOut(out);
    return;
  }

  // --from-dataset: build the bundle from a pre-sampled dataset (assets/tracks.json
  // by default, or $TRACKS_DATASET) keyed by iRacing track id. No iRacing API,
  // no SVG fetching — the points are already sampled and normalized.
  if (FROM_DATASET) {
    const ds = readJson(DATASET, null);
    if (!ds || typeof ds !== "object") {
      console.error(`Could not read dataset: ${DATASET}`);
      process.exit(1);
    }
    const ids = Object.keys(ds);
    console.log(`Converting ${ids.length} tracks from ${DATASET}`);
    let ok = 0;
    for (const idStr of ids) {
      if (!/^\d+$/.test(idStr)) continue; // keys must be numeric iRacing track ids
      const entry = ds[idStr];
      try {
        const { points, turns } = bakeFromSampled(entry, overrides[idStr]);
        out[idStr] = {
          name: entry.name ?? entry.trackName ?? null,
          config: entry.config ?? null,
          points,
          ...(turns.length ? { turns } : {}),
        };
        ok++;
      } catch (e) {
        console.warn(`  skip ${idStr}: ${e.message}`);
      }
    }
    console.log(`Baked ${ok}/${ids.length} tracks.`);
    writeOut(out);
    return;
  }

  // OAuth2 (the current iRacing auth; legacy password login was retired
  // 2025-12-09). The "password_limited" grant is iRacing's headless-script flow:
  // exchange a registered client_id/secret + account login for a Bearer token,
  // then hit the data API with it. Requires an OAuth client registered with
  // iRacing (see README); credentials come from env vars.
  const clientId = process.env.IRACING_CLIENT_ID;
  const clientSecret = process.env.IRACING_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const email = process.env.IRACING_LOGIN;
    const password = process.env.IRACING_PWD;
    if (!email || !password) {
      console.error("OAuth needs IRACING_LOGIN and IRACING_PWD alongside the client id/secret.");
      process.exit(1);
    }
    // iRacing masks both secrets the same way: base64(sha256(secret + normalizedId)),
    // where the id is trimmed + lowercased (client_id for the secret, username for
    // the password).
    const mask = (secret, id) =>
      createHash("sha256").update(secret + id.trim().toLowerCase()).digest("base64");
    const body = new URLSearchParams({
      grant_type: "password_limited",
      client_id: clientId,
      client_secret: mask(clientSecret, clientId),
      username: email,
      password: mask(password, email),
      scope: "iracing.auth",
    });
    const res = await fetch("https://oauth.iracing.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const tok = await res.json().catch(() => null);
    if (!res.ok || !tok?.access_token) {
      console.error(`OAuth token request failed (${res.status}). iRacing replied:`);
      console.error(JSON.stringify(tok, null, 2));
      process.exit(1);
    }
    await bakeFromDataApi({ authorization: `Bearer ${tok.access_token}` }, overrides, out);
    return;
  }

  // Browser-auth: replay the cookie (and optional Authorization header) that a
  // signed-in browser already holds, hitting the data API directly. Grab the
  // header values from DevTools (see README) and pass them as env vars.
  const cookie = process.env.IRACING_COOKIE;
  if (cookie) {
    const authHeader = process.env.IRACING_AUTH;
    await bakeFromDataApi({ cookie, ...(authHeader ? { authorization: authHeader } : {}) }, overrides, out);
    return;
  }

  // --offline: no login. Bake from two JSON files saved from a browser that's
  // already signed in to iRacing (sidesteps the API-login CAPTCHA entirely):
  //   scripts/iracing-data/assets.json  <- https://members-ng.iracing.com/data/track/assets
  //   scripts/iracing-data/tracks.json  <- https://members-ng.iracing.com/data/track/get
  if (OFFLINE) {
    const assets = await loadOffline(join(DATA_DIR, "assets.json"), "assets");
    if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
      throw new Error("assets.json is not a track-asset object");
    }
    let tracks = null;
    try {
      tracks = await loadOffline(join(DATA_DIR, "tracks.json"), "tracks");
    } catch (e) {
      console.warn(`Track list unavailable (${e.message}); using fallback names.`);
    }
    await processAssets(assets, tracks, overrides, out);
    return;
  }

  const email = process.env.IRACING_LOGIN;
  const password = process.env.IRACING_PWD;
  if (!email || !password) {
    console.error(
      "Set IRACING_LOGIN and IRACING_PWD, or run with --offline (browser-saved\n" +
        "data, no login) or --rebake (re-bake from cache). See README.",
    );
    process.exit(1);
  }

  // `iracing-api` ships as ESM but with extensionless internal imports (e.g.
  // `from './api'`), which Node's native resolver rejects. A resolve hook that
  // retries failed relative specifiers with a `.js` suffix lets it load; it's
  // registered here (before the dynamic import) so it only affects this path —
  // --rebake never imports the package.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (specifier.startsWith(".") && !/\.[mc]?js$/.test(specifier)) {
          return nextResolve(specifier + ".js", context);
        }
        throw err;
      }
    },
  });
  const { default: IracingAPI } = await import("iracing-api");

  const iracing = new IracingAPI();
  const auth = await iracing.login(email, password);
  // iRacing returns HTTP 200 even when auth didn't fully succeed (wrong
  // password, e-mail verification, or CAPTCHA required), so check the body.
  if (!auth || auth.error || auth.authcode === 0 || auth.authcode === "0" || auth.verificationRequired) {
    console.error("Login did not authenticate. iRacing replied:");
    console.error(JSON.stringify(auth, null, 2));
    console.error(
      "\niRacing RETIRED legacy username/password API auth on 2025-12-09, so this\n" +
        "path no longer works (you'll see error 'Not Allowed'). Use one of:\n" +
        "  • OAuth2 (recommended): set IRACING_CLIENT_ID + IRACING_CLIENT_SECRET\n" +
        "    (plus IRACING_LOGIN/IRACING_PWD) — uses the password_limited grant.\n" +
        "  • --offline: bake from browser-saved data/track JSON files.\n" +
        "See the README 'Track maps' section.",
    );
    process.exit(1);
  }

  // Track assets carry the map layers but no display name; the track list
  // supplies name/config. The list is optional — if it fails we fall back to
  // "track <id>" names (the baked geometry is identical either way).
  const assets = await iracing.track.getTrackAssets();
  if (!assets || typeof assets !== "object" || Array.isArray(assets) || assets.error) {
    console.error("Could not fetch track assets. iRacing replied:");
    console.error(JSON.stringify(assets, null, 2));
    process.exit(1);
  }

  const tracks = await iracing.track.getTracks();
  if (!Array.isArray(tracks)) {
    console.warn("Track list unavailable; using fallback names. iRacing replied:");
    console.warn(JSON.stringify(tracks));
  }
  await processAssets(assets, tracks, overrides, out);
}

// Hit the iRacing data API with the given auth headers (Bearer token or cookie),
// following the `{ link }` indirection, then bake. Shared by the OAuth + cookie
// paths.
async function bakeFromDataApi(headers, overrides, out) {
  const fetchData = async (endpoint) => {
    const res = await fetch(`https://members-ng.iracing.com/${endpoint}`, { headers });
    if (!res.ok) throw new Error(`${endpoint} -> ${res.status} ${res.statusText}`);
    const j = await res.json();
    return j?.link ? camelizeKeys(await (await fetch(j.link)).json()) : camelizeKeys(j);
  };

  let assets;
  try {
    assets = await fetchData("data/track/assets");
  } catch (e) {
    console.error(`Could not fetch track assets: ${e.message}`);
    console.error("The token/cookie may be expired or lack data-API access.");
    process.exit(1);
  }
  if (!assets || typeof assets !== "object" || Array.isArray(assets) || assets.error) {
    console.error("Track assets response wasn't usable. iRacing replied:");
    console.error(JSON.stringify(assets, null, 2));
    process.exit(1);
  }
  let tracks = null;
  try {
    tracks = await fetchData("data/track/get");
  } catch (e) {
    console.warn(`Track list unavailable (${e.message}); using fallback names.`);
  }
  await processAssets(assets, tracks, overrides, out);
}

// Download (or reuse cached) SVG layers for every track asset, bake each into a
// normalized centerline, and write the bundle. Shared by the online + offline
// paths; `tracks` may be null/non-array (then names fall back to "track <id>").
async function processAssets(assets, tracks, overrides, out) {
  const meta = new Map();
  if (Array.isArray(tracks)) {
    for (const t of tracks) meta.set(t.trackId, { name: t.trackName, config: t.configName ?? null });
  }

  const ids = Object.keys(assets);
  console.log(`Found ${ids.length} track assets.`);
  let ok = 0;
  for (const idStr of ids) {
    const id = Number(idStr);
    const asset = assets[idStr];
    const info = meta.get(id) || { name: `track ${id}`, config: null };
    const cacheFile = join(CACHE_DIR, `${id}.json`);

    let raw = !REFRESH && existsSync(cacheFile) ? readJson(cacheFile, null) : null;
    if (!raw?.activeD) {
      try {
        const fetched = await fetchRaw(asset);
        raw = { trackId: id, name: info.name, config: info.config, ...fetched };
        writeFileSync(cacheFile, JSON.stringify(raw));
      } catch (e) {
        console.warn(`  fetch fail ${id} ${info.name}: ${e.message}`);
        continue;
      }
    } else {
      // Keep cached display name/config in step with the latest track list.
      raw.name = info.name;
      raw.config = info.config;
    }

    if (!raw.activeD) {
      console.warn(`  no centerline for ${id} ${info.name}`);
      continue;
    }
    try {
      const points = bake(raw, overrides[idStr]);
      out[idStr] = { name: info.name, config: info.config, points };
      ok++;
    } catch (e) {
      console.warn(`  bake fail ${id} ${info.name}: ${e.message}`);
    }
  }
  console.log(`Baked ${ok}/${ids.length} tracks.`);
  writeOut(out);
}

// Pure helpers are exported so the bake / SVG-parsing logic can be exercised on
// synthetic SVG input without iRacing credentials.
export { extractPathDs, longestPath, centroidOf, turnOnePoint, nearestIndex, bake };

// Only fetch/bake when run as the entry point (not when imported for tests).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
