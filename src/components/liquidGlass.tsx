// Panel chrome wrappers — tokens come from the active Theme pack so flat/liquid
// surfaces stay in lockstep across WidgetHost and self-painting widgets.

import type { CSSProperties } from "react";
import type { Theme } from "../theme/theme";

/** @deprecated Prefer theme.glass — kept for SVG filter id stability. */
export const GLASS_FILTER_ID = "lg-refract";

/** Kept for gallery / future refraction experiments — not applied to panels. */
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

/** Liquid-glass fill from theme tokens. `alpha` is the user's panel opacity. */
export function glassChrome(theme: Theme, alpha = 1): CSSProperties {
  const a = Math.max(0, Math.min(1, alpha));
  const g = theme.glass;
  const [r, gch, b] = g.fillRgb;
  return {
    background:
      `linear-gradient(180deg, rgba(255,255,255,${g.sheenTop * a}), rgba(255,255,255,0) 36%), ` +
      `linear-gradient(160deg, rgba(255,255,255,${g.sheenDiag * a}), rgba(255,255,255,${g.sheenDiagEnd * a})), ` +
      `rgba(${r},${gch},${b},${g.fillAlpha * a})`,
    border: g.border,
    borderRadius: g.radius,
    boxShadow: g.shadow,
    backdropFilter: g.blur,
    WebkitBackdropFilter: g.blur,
  };
}

/** Flat or liquid panel surface — identical for host + self-chrome widgets. */
export function panelChrome(theme: Theme, glass: boolean, alpha = 1): CSSProperties {
  const a = Math.max(0, Math.min(1, alpha));
  if (glass) {
    return {
      ...glassChrome(theme, a),
      position: "relative",
      overflow: "hidden",
    };
  }
  const [r, g, b] = theme.glass.flatRgb;
  return {
    background: `rgba(${r}, ${g}, ${b}, ${a})`,
    border: `1px solid ${theme.colors.surfaceBorder}`,
    borderRadius: theme.radius,
    backdropFilter: theme.panelBlur,
    WebkitBackdropFilter: theme.panelBlur,
    boxShadow: theme.panelShadow,
    position: "relative",
    overflow: "hidden",
  };
}

/** Specular highlight — reads gradient from the active theme. */
export function GlassSpecular({ theme, radius }: { theme: Theme; radius?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: radius ?? theme.glass.radius,
        pointerEvents: "none",
        zIndex: 0,
        background: theme.glass.specular,
      }}
    />
  );
}

/** Border / shadow tokens for host edit chrome (liquid mode). */
export function glassBorderOf(theme: Theme): string {
  return theme.glass.border;
}
export function glassShadowOf(theme: Theme): string {
  return theme.glass.shadow;
}
export function glassRadiusOf(theme: Theme): number {
  return theme.glass.radius;
}
