import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and a quiet dev server.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
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
