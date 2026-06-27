// Bump the app version in one shot so the three manifests never drift:
//   - package.json        (drives the version shown in the UI / Settings > About)
//   - src-tauri/tauri.conf.json (drives the installer + bundle version)
//   - Cargo.toml [workspace.package] (drives the compiled binary version)
//
// Usage: npm run set-version 0.2.0
//        node scripts/set-version.mjs 1.0.0

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Usage: npm run set-version <semver>\n  e.g. npm run set-version 0.2.0\n  (got: ${version ?? "<nothing>"})`);
  process.exit(1);
}

function bumpJson(rel, key = "version") {
  const file = path.join(ROOT, rel);
  const json = JSON.parse(readFileSync(file, "utf-8"));
  const old = json[key];
  json[key] = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  return old;
}

// Replace the first top-level `version = "..."` — it's the [workspace.package] one.
function bumpCargo(rel) {
  const file = path.join(ROOT, rel);
  const text = readFileSync(file, "utf-8");
  let old;
  const next = text.replace(/^version = "([^"]*)"/m, (_, v) => {
    old = v;
    return `version = "${version}"`;
  });
  if (old === undefined) throw new Error(`No \`version = "..."\` found in ${rel}`);
  writeFileSync(file, next);
  return old;
}

const changes = [
  ["package.json", bumpJson("package.json")],
  ["src-tauri/tauri.conf.json", bumpJson("src-tauri/tauri.conf.json")],
  ["Cargo.toml", bumpCargo("Cargo.toml")],
];

console.log(`Set version → ${version}`);
for (const [file, old] of changes) console.log(`  ${file}: ${old} → ${version}`);
console.log(`\nNext: rebuild the installer (npm run tauri build) and commit.`);
