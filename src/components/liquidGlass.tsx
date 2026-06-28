// "Liquid Glass" panel chrome — an opt-in alternative to the flat-glass theme,
// applied to every widget panel when the user picks it (Settings → Panel style).
//
// Layers (Apple iOS-26 style): a refraction of whatever is behind the panel
// (SVG feTurbulence + feDisplacementMap used as a backdrop-filter), a frosted
// blur+saturate, a translucent tint, a bright specular highlight, and an inset
// rim that catches light. The SVG-filter backdrop only works in Chromium —
// WebView2 (the desktop overlay) and Chrome (dev) — which is all we ship.

import type { CSSProperties } from "react";

export const GLASS_FILTER_ID = "lg-refract";
export const GLASS_RADIUS = 22;
export const GLASS_SHADOW =
  "0 10px 44px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3), " +
  "inset 0 1px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(255,255,255,0.08), " +
  "inset 0 -10px 28px rgba(255,255,255,0.045)";
export const GLASS_BORDER = "1px solid rgba(255,255,255,0.22)";

/**
 * Inject once per window (overlay + manager). A hidden, zero-size SVG holding the
 * refraction filter that `glassChrome` references. Cheap when unused.
 */
export function LiquidGlassFilter() {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: "absolute", pointerEvents: "none" }}>
      <filter id={GLASS_FILTER_ID} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.008 0.011" numOctaves={2} seed={11} result="noise" />
        <feGaussianBlur in="noise" stdDeviation={1.6} result="noiseBlur" />
        <feDisplacementMap in="SourceGraphic" in2="noiseBlur" scale={11} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

/** Liquid-glass panel surface. `alpha` (0..1) scales the fill so the per-widget
 *  opacity control still dims the panel.
 *
 *  Legibility over busy/bright sim backgrounds comes from two things: a **dark
 *  translucent base** under the glass (so content always has contrast) and a
 *  **strong frosted blur** (so the scene behind reads as a soft wash, not detail
 *  competing with the text). The white sheen + rim sit on top for the glass look. */
export function glassChrome(alpha = 1): CSSProperties {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    background:
      // top-light sheen (glass)…
      `linear-gradient(180deg, rgba(255,255,255,${0.1 * a}), rgba(255,255,255,0) 40%), ` +
      `linear-gradient(160deg, rgba(255,255,255,${0.05 * a}), rgba(255,255,255,${0.015 * a})), ` +
      // …over a dark base for readability.
      `rgba(13,15,21,${0.62 * a})`,
    border: GLASS_BORDER,
    borderRadius: GLASS_RADIUS,
    boxShadow: GLASS_SHADOW,
    // Heavier blur + no brightness boost so bright scenes don't wash out the text.
    backdropFilter: `blur(10px) saturate(150%) url(#${GLASS_FILTER_ID})`,
    WebkitBackdropFilter: `blur(10px) saturate(150%) url(#${GLASS_FILTER_ID})`,
  };
}

/** Specular "light catch" — place inside the panel (behind the content, which
 *  should sit at zIndex ≥ 1 so text stays crisp). */
export function GlassSpecular({ radius = GLASS_RADIUS }: { radius?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: radius,
        pointerEvents: "none",
        zIndex: 0,
        background:
          "radial-gradient(120% 75% at 24% -14%, rgba(255,255,255,0.22), rgba(255,255,255,0.04) 32%, transparent 54%)",
      }}
    />
  );
}
