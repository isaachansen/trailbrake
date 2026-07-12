// Shared panel surface — ONE paint path for WidgetHost and self-chrome widgets
// (Relative sections, Spotter card, …). Same alpha in → same look out.
//
// Liquid Glass layers: frosted blur + translucent tint + specular rim. The SVG
// refraction filter is intentionally NOT applied here — it only works reliably
// on untransformed hosts, and Relative's sections live inside FitContent's
// `transform: scale(...)`, where refraction also broke sibling backdrop-filters
// in WebView2. Blur-only keeps every panel visually locked together.

import type { CSSProperties } from "react";
import type { Theme } from "../theme/theme";

export const GLASS_FILTER_ID = "lg-refract";
export const GLASS_RADIUS = 12;
export const GLASS_SHADOW =
  "0 10px 44px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3), " +
  "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 0 0 1px rgba(255,255,255,0.05), " +
  "inset 0 -10px 28px rgba(255,255,255,0.02)";
export const GLASS_BORDER = "1px solid rgba(255,255,255,0.14)";

/** Kept for the gallery / future experiments — not referenced by `glassChrome`. */
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

/** Liquid-glass fill. `alpha` (0..1) is the user's panel opacity setting. */
export function glassChrome(alpha = 1): CSSProperties {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    background:
      `linear-gradient(180deg, rgba(255,255,255,${0.045 * a}), rgba(255,255,255,0) 36%), ` +
      `linear-gradient(160deg, rgba(255,255,255,${0.022 * a}), rgba(255,255,255,${0.008 * a})), ` +
      `rgba(13,15,21,${0.72 * a})`,
    border: GLASS_BORDER,
    borderRadius: GLASS_RADIUS,
    boxShadow: GLASS_SHADOW,
    backdropFilter: "blur(10px) saturate(150%)",
    WebkitBackdropFilter: "blur(10px) saturate(150%)",
  };
}

/** Flat or liquid panel surface — identical whether painted by WidgetHost or a
 *  self-chrome widget. Pass the same `alpha` and they match. */
export function panelChrome(theme: Theme, glass: boolean, alpha = 1): CSSProperties {
  const a = Math.max(0, Math.min(1, alpha));
  if (glass) {
    return {
      ...glassChrome(a),
      position: "relative",
      overflow: "hidden",
    };
  }
  return {
    background: `rgba(18, 20, 27, ${a})`,
    border: `1px solid ${theme.colors.surfaceBorder}`,
    borderRadius: theme.radius,
    backdropFilter: theme.panelBlur,
    WebkitBackdropFilter: theme.panelBlur,
    boxShadow: theme.panelShadow,
    position: "relative",
    overflow: "hidden",
  };
}

/** Specular "light catch" — place inside the panel (content at zIndex ≥ 1). */
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
          "radial-gradient(120% 75% at 24% -14%, rgba(255,255,255,0.09), rgba(255,255,255,0.02) 32%, transparent 54%)",
      }}
    />
  );
}
