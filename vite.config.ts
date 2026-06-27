import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and a quiet dev server.
const host = process.env.TAURI_DEV_HOST;

// Single source of truth for the app version shown in the UI: package.json.
// Injected at build/dev time as the global `__APP_VERSION__` (see vite-env.d.ts).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // Manufacturer badges are tinted via CSS `mask-image`. WebView2 (the release
    // build's webview) won't resolve Vite's url-encoded `data:` SVG masks — they
    // render as solid white squares — while emitted asset *files* load fine. Dev
    // always serves file URLs, so this only broke in the installer build. Force
    // the car-icon SVGs to be emitted as files (never inlined) so the masks work
    // everywhere. Other assets keep the default inlining behaviour.
    assetsInlineLimit: (filePath: string) =>
      filePath.includes("car_icons") ? false : undefined,
  },
  // Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1430 }
      : undefined,
    watch: {
      // Don't watch the Rust side from the frontend dev server.
      ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"],
    },
  },
});
