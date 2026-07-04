// Supply-chain gate: fail when any dependency version pinned in
// package-lock.json was published to the npm registry less than MIN_AGE_DAYS
// ago. Freshly-published versions are the risk window for worm-style
// compromises (Shai-Hulud et al.) — malicious releases are typically yanked
// within days, so refusing young versions sidesteps almost all of them.
//
// Ages are measured against *now*, so a version that was young when it
// slipped in still fails until it has aged. Run manually with
// `npm run check-deps`; CI runs it on every change to the package manifests.
// No dependencies — plain Node 18+ (global fetch).

import { readFileSync } from "node:fs";

const MIN_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 10;
const REGISTRY = "https://registry.npmjs.org";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

// Collect unique name → versions actually pinned by the lockfile.
const wanted = new Map();
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!path || info.link || !info.version) continue; // skip the root entry and links
  const name = info.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  if (!wanted.has(name)) wanted.set(name, new Set());
  wanted.get(name).add(info.version);
}

async function fetchPackument(name, attempt = 1) {
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
      return fetchPackument(name, attempt + 1);
    }
    throw new Error(`${name}: registry fetch failed (${e.message})`);
  }
}

const names = [...wanted.keys()];
const violations = [];
const errors = [];
let checked = 0;

async function worker() {
  while (names.length) {
    const name = names.pop();
    try {
      const doc = await fetchPackument(name);
      for (const version of wanted.get(name)) {
        const published = doc.time?.[version];
        if (!published) {
          errors.push(`${name}@${version}: no publish time in registry metadata`);
          continue;
        }
        const ageDays = (Date.now() - Date.parse(published)) / MS_PER_DAY;
        if (ageDays < MIN_AGE_DAYS) {
          violations.push(`${name}@${version} published ${ageDays.toFixed(1)} days ago (${published})`);
        }
      }
    } catch (e) {
      errors.push(String(e.message ?? e));
    }
    checked++;
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`checked ${checked} packages (${MIN_AGE_DAYS}-day minimum publish age)`);
if (violations.length) {
  console.error(`\nFAIL — versions younger than ${MIN_AGE_DAYS} days:\n  ` + violations.join("\n  "));
  console.error("\nWait for the version to age, or pin an older release (npm run add -- <pkg>@<older-version>).");
}
if (errors.length) {
  // Fail closed: an unverifiable dependency is an unverified dependency.
  console.error(`\nFAIL — could not verify:\n  ` + errors.join("\n  "));
}
process.exit(violations.length || errors.length ? 1 : 0);
