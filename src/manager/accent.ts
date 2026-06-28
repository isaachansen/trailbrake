// Manager UI accent color. The user picks one in Settings; it's persisted in
// app settings and applied as the `--accent` family of CSS variables on the
// `.mgr` root (see `ManagerApp`), so the whole control UI re-tints to taste.

import type { CSSProperties } from "react";

/** Curated accent choices shown as swatches in Settings (first = default). */
export const ACCENT_PRESETS: { hex: string; name: string }[] = [
  { hex: "#ff2d8e", name: "Pink" },
  { hex: "#ff495e", name: "Red" },
  { hex: "#ff8a3d", name: "Orange" },
  { hex: "#ffb43d", name: "Amber" },
  { hex: "#2fe08a", name: "Green" },
  { hex: "#37d4ea", name: "Cyan" },
  { hex: "#3d8bff", name: "Blue" },
  { hex: "#b06bff", name: "Purple" },
];

/** `#rgb` / `#rrggbb` → `rgba(r, g, b, a)`; falls back to the default pink. */
export function accentRgba(hex: string, alpha: number): string {
  const h = (hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return `rgba(255, 45, 142, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Darken a hex by scaling each channel toward black (factor < 1). Used for the
 * `--accent-dark` hover tint so primary buttons darken in the *chosen* accent
 * rather than a fixed pink. Falls back to a darkened default pink on bad input.
 */
export function accentDarken(hex: string, factor = 0.82): string {
  const h = (hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return "#d12574";
  const scale = (c: number) => Math.max(0, Math.min(255, Math.round(c * factor)));
  const r = scale((n >> 16) & 255);
  const g = scale((n >> 8) & 255);
  const b = scale(n & 255);
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

/**
 * The `--accent*` custom properties for a chosen accent, applied inline on the
 * `.mgr` root so they override the stylesheet defaults with no load flash. The
 * alphas mirror the original values in `manager.css`.
 */
export function accentVars(hex: string): CSSProperties {
  return {
    "--accent": hex,
    "--accent-dark": accentDarken(hex),
    "--accent-soft": accentRgba(hex, 0.14),
    "--accent-line": accentRgba(hex, 0.42),
    "--accent-glow": accentRgba(hex, 0.16),
  } as CSSProperties;
}
