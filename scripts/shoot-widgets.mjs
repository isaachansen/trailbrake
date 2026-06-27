// Widget screenshot capture — renders every widget in isolation (via the
// `?gallery` route) and saves a PNG per widget plus a contact sheet, so agents
// and humans can SEE the UI and review it. No big downloads: it drives the
// system Chrome through the already-installed `playwright-core`.
//
// Usage:
//   node scripts/shoot-widgets.mjs                 # all widgets + contact sheet
//   node scripts/shoot-widgets.mjs --widget=radar  # just one widget
//   node scripts/shoot-widgets.mjs --bg=dark --size=min
//   node scripts/shoot-widgets.mjs --no-server     # reuse a dev server already on --port
//
// Flags:
//   --widget=<id>     only this widget (repeatable: --widget=a --widget=b)
//   --bg=<key>        backdrop: track (default) | dark | light | checker
//   --size=<mode>     default (authored) | min | large
//   --scale=<n>       widget density multiplier (default 1)
//   --opacity=<0..1>  panel opacity (default 1)
//   --config=<json>   JSON merged over the widget's defaultConfig (single widget)
//   --out=<dir>       output dir (default widget-shots/)
//   --port=<n>        dev server port (default 5179)
//   --no-server       don't spawn vite; assume one is already serving --port
//   --no-sheet        skip the all-in-one contact sheet
//   --scale-factor=<n> device pixel ratio for crispness (default 2)

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

function parseArgs(argv) {
  const a = { widgets: [], bg: "track", size: "default", scale: "1", opacity: "1",
    out: "widget-shots", port: "5179", server: true, sheet: true, scaleFactor: "2", config: "" };
  for (const arg of argv) {
    const [k, v = ""] = arg.replace(/^--/, "").split("=");
    if (k === "widget") a.widgets.push(v);
    else if (k === "no-server") a.server = false;
    else if (k === "no-sheet") a.sheet = false;
    else if (k === "scale-factor") a.scaleFactor = v;
    else if (k in a) a[k] = v;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(ROOT, args.out);

function galleryUrl(extra = {}) {
  const p = new URLSearchParams({ gallery: "1", bg: args.bg, size: args.size, scale: args.scale, opacity: args.opacity });
  if (args.config) p.set("config", args.config);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return `${BASE}/?${p.toString()}`;
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      if (r.ok || r.status === 304) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`Dev server did not come up at ${url} within ${timeoutMs}ms`);
}

async function launchBrowser() {
  const opts = { headless: true };
  // Prefer the installed Chrome channel; fall back to common install paths so the
  // script works without `playwright install`.
  const tries = [
    { ...opts, channel: "chrome" },
    { ...opts, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" },
    { ...opts, executablePath: "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" },
    opts,
  ];
  let lastErr;
  for (const t of tries) {
    try {
      return await chromium.launch(t);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not launch Chrome. Install Google Chrome or run \`npx playwright install chromium\`.\n${lastErr}`);
}

async function settle(page) {
  await page.waitForFunction(() => window.__GALLERY_READY__ === true, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  // Let mock animation + FitContent's measure/shrink passes stabilize.
  await page.waitForTimeout(700);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let vite;
  if (args.server) {
    const viteBin = path.resolve(ROOT, "node_modules/vite/bin/vite.js");
    console.log(`▶ starting vite on :${PORT}`);
    vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    vite.on("error", (e) => console.error("vite failed:", e));
  }

  const browser = await launchBrowser();
  try {
    await waitForServer(`${BASE}/`);
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: Number(args.scaleFactor),
    });
    const page = await context.newPage();

    // Discover the registry from the running app (single source of truth).
    await page.goto(galleryUrl(), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Array.isArray(window.__WIDGETS__), { timeout: 15000 });
    const registry = await page.evaluate(() => window.__WIDGETS__);
    const wanted = args.widgets.length ? registry.filter((w) => args.widgets.includes(w.id)) : registry;
    if (!wanted.length) {
      throw new Error(`No matching widgets. Known ids: ${registry.map((w) => w.id).join(", ")}`);
    }

    // Contact sheet (full page) — skip when targeting specific widgets unless asked.
    const manifest = { generatedAt: new Date().toISOString(), bg: args.bg, size: args.size, widgets: [] };
    if (args.sheet && !args.widgets.length) {
      await page.goto(galleryUrl(), { waitUntil: "networkidle" });
      await settle(page);
      const sheet = path.join(OUT, "_contact-sheet.png");
      await page.screenshot({ path: sheet, fullPage: true });
      console.log(`■ contact sheet → ${path.relative(ROOT, sheet)}`);
      manifest.contactSheet = "_contact-sheet.png";
    }

    // Per-widget clean shots.
    for (const w of wanted) {
      await page.goto(galleryUrl({ widget: w.id }), { waitUntil: "networkidle" });
      await settle(page);
      const el = await page.$("[data-widget-shot]");
      const file = `${w.id}.png`;
      if (el) {
        await el.screenshot({ path: path.join(OUT, file) });
      } else {
        await page.screenshot({ path: path.join(OUT, file) });
      }
      console.log(`□ ${w.name} (${w.id}) → ${file}`);
      manifest.widgets.push({
        id: w.id,
        name: w.name,
        file,
        defaultSize: w.defaultSize,
        minSize: w.minSize,
        transparentPanel: w.transparentPanel,
        requiredCapabilities: w.requiredCapabilities,
        description: w.description,
      });
    }

    await writeFile(path.join(OUT, "index.json"), JSON.stringify(manifest, null, 2));
    console.log(`\n✓ ${manifest.widgets.length} widget shot(s) in ${path.relative(ROOT, OUT)}/  (manifest: index.json)`);
  } finally {
    await browser.close();
    if (vite) vite.kill();
  }
}

main().catch((e) => {
  console.error("\n✗ capture failed:", e.message ?? e);
  process.exitCode = 1;
});
