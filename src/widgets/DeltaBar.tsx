// Delta bar: live delta to best / session-best lap, color-coded gain/loss.
// Slow-path widget — re-renders only when the slow sample changes.

import { useSlow } from "../store/hooks";
import { fmtDelta } from "./format";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

/** Deltas beyond this magnitude are out-lap / invalid-lap artefacts. */
const MAX_VALID_DELTA_S = 30;
const validDelta = (d: number | null | undefined): number | null =>
  d != null && isFinite(d) && Math.abs(d) <= MAX_VALID_DELTA_S ? d : null;

export interface DeltaBarConfig {
  reference: "best" | "sessionBest";
  /** Full-scale of the bar in seconds (|delta| beyond this pins to the end). */
  rangeS: number;
  showNumeric: boolean;
}

const defaultConfig: DeltaBarConfig = {
  reference: "best",
  rangeS: 1.5,
  showNumeric: true,
};

function DeltaBar({ theme, config }: BaseWidgetProps<DeltaBarConfig>) {
  const slow = useSlow();
  // A "vs best" delta with no best lap to be relative to is meaningless — treat
  // as absent (empty bar, "--") rather than trusting a fabricated value.
  const rawDelta =
    config.reference === "best"
      ? slow?.bestLapS != null
        ? slow?.deltaBestS
        : null
      : slow?.deltaSessionBestS;
  // Bar uses the raw delta (already clamped to ±rangeS by frac below), but the
  // numeric readout uses a validity-gated value so out-lap spikes show "--".
  const delta = rawDelta ?? null;
  const displayDelta = validDelta(rawDelta);

  const gaining = delta != null && delta < 0; // faster than reference
  const color = delta == null ? theme.colors.textDim : gaining ? theme.colors.gain : theme.colors.loss;
  const frac = delta == null ? 0 : Math.max(-1, Math.min(1, delta / config.rangeS));
  const widthPct = Math.abs(frac) * 50;
  // Faster (green) grows to the RIGHT of center; slower (red) grows to the LEFT.
  const leftPct = gaining ? 50 : 50 - widthPct;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: "0.5em",
        padding: theme.widgetPad,
        boxSizing: "border-box",
        color: theme.colors.text,
      }}
    >
      {/* center-anchored fill bar. `isolation: isolate` keeps this off the panel's
          backdrop-filter raster layer, which otherwise leaves a 1px anti-aliased
          hairline along the fill's straight edges in WebView2. */}
      <div style={{ position: "relative", height: "1.3em", borderRadius: "0.65em", background: "rgba(255,255,255,0.07)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)", overflow: "hidden", isolation: "isolate" }}>
        <div style={{ position: "absolute", left: "50%", top: 3, bottom: 3, width: 2, background: "rgba(255,255,255,0.55)", transform: "translateX(-50%)" }} />
        <div
          style={{
            position: "absolute",
            top: 3,
            bottom: 3,
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            background: color,
            // Flat against the center line, rounded on the outer end: gain grows
            // right (round the right), loss grows left (round the left).
            borderRadius: gaining ? "0 0.45em 0.45em 0" : "0.45em 0 0 0.45em",
            transition: "left 0.12s linear, width 0.12s linear",
            // Force a clean integer-aligned GPU layer so the rounded edges don't
            // sub-pixel-shimmer into a dotted seam on the desktop overlay.
            transform: "translateZ(0)",
            backfaceVisibility: "hidden",
          }}
        />
      </div>

      {config.showNumeric && (
        <div style={{ textAlign: "center" }}>
          <span style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "2em", lineHeight: 1, color }}>{displayDelta != null ? fmtDelta(displayDelta) : "--"}</span>
          <span style={{ fontFamily: theme.font.label, fontSize: "0.66em", fontWeight: 600, letterSpacing: "0.14em", color: theme.colors.textDim2, marginLeft: "0.7em" }}>
            vs {config.reference === "best" ? "BEST" : "SESSION BEST"}
          </span>
        </div>
      )}
    </div>
  );
}

export const deltaBarDef: WidgetDefinition<DeltaBarConfig> = {
  id: "delta-bar",
  name: "Delta Bar",
  defaultSize: { w: 300, h: 66 },
  minSize: { w: 180, h: 56 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["deltas"],
  configSchema: [
    {
      key: "reference",
      label: "Reference",
      type: "enum",
      options: [
        { value: "best", label: "Personal best" },
        { value: "sessionBest", label: "Session best" },
      ],
    },
    { key: "rangeS", label: "Range (s)", type: "number", min: 0.3, max: 5, step: 0.1 },
    { key: "showNumeric", label: "Show number", type: "boolean" },
  ],
  Component: DeltaBar,
};
