// Cooldown-aware dependency installer:
//   npm run add -- <pkg>[@version] [--dev] [--dry-run]
//
// Resolves the newest STABLE version of <pkg> that has been on the registry
// for at least MIN_AGE_DAYS (or verifies the age of an explicitly requested
// version), then installs it with an exact pin and scripts disabled. This is
// the front door for adding or updating a dependency in this repo — a
// freshly-compromised release can't be picked up until it has survived two
// weeks in public (worm releases get yanked in days).
// No dependencies — plain Node 18+ (global fetch).

import { spawnSync } from "node:child_process";

const MIN_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org";

const args = process.argv.slice(2);
const dev = args.includes("--dev");
const dryRun = args.includes("--dry-run");
const spec = args.find((a) => !a.startsWith("--"));
if (!spec) {
  console.error("usage: npm run add -- <pkg>[@version] [--dev] [--dry-run]");
  process.exit(2);
}

// Split name@version, handling scoped names (@scope/name@1.2.3).
const at = spec.lastIndexOf("@");
const explicit = at > 0 ? spec.slice(at + 1) : null;
const name = at > 0 ? spec.slice(0, at) : spec;

const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, { headers: { accept: "application/json" } });
if (!res.ok) {
  console.error(`${name}: registry lookup failed (HTTP ${res.status})`);
  process.exit(1);
}
const doc = await res.json();
const time = doc.time ?? {};

const ageDays = (v) => (Date.now() - Date.parse(time[v])) / MS_PER_DAY;

let version = explicit;
if (version) {
  if (!time[version]) {
    console.error(`${name}@${version}: no such version on the registry`);
    process.exit(1);
  }
  if (ageDays(version) < MIN_AGE_DAYS) {
    console.error(
      `${name}@${version} was published ${ageDays(version).toFixed(1)} days ago — younger than the ${MIN_AGE_DAYS}-day cooldown.\n` +
        `Pick an older version, or wait it out.`
    );
    process.exit(1);
  }
} else {
  // Newest stable (non-prerelease) version old enough, by semver order.
  const candidates = Object.keys(time)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => ageDays(v) >= MIN_AGE_DAYS)
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
  version = candidates.at(-1);
  if (!version) {
    console.error(`${name}: no stable version is at least ${MIN_AGE_DAYS} days old`);
    process.exit(1);
  }
  const latest = doc["dist-tags"]?.latest;
  if (latest && latest !== version) {
    console.log(`note: latest is ${latest}, but it is inside the cooldown window or a prerelease — using ${version}`);
  }
}

console.log(`${name}@${version} (published ${time[version]}, ${ageDays(version).toFixed(1)} days old)`);
if (dryRun) {
  console.log("dry run — not installing");
  process.exit(0);
}

const npmArgs = ["install", `${name}@${version}`, "--save-exact", "--ignore-scripts", ...(dev ? ["--save-dev"] : [])];
console.log(`> npm ${npmArgs.join(" ")}`);
const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
