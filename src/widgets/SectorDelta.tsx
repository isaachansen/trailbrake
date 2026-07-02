import { useSlow } from "../store/hooks";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface SectorDeltaConfig {
  precision: "1" | "2" | "3";
}

const defaultConfig: SectorDeltaConfig = {
  precision: "2",
};

const SECTOR_KEYS = ["s1", "s2", "s3"] as const;
const BAR_RANGE_S = 1.0;
const CLOSE_THRESHOLD_S = 0.1;
/** Sector deltas beyond this are out-lap / invalid artefacts. */
const MAX_VALID_SECTOR_DELTA_S = 10;
const validDelta = (d: number | null): number | null =>
  d != null && isFinite(d) && Math.abs(d) <= MAX_VALID_SECTOR_DELTA_S ? d : null;

function SectorDelta({ theme, config }: BaseWidgetProps<SectorDeltaConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;
  const precision = Number(config.precision);

  const cur = slow?.sectorTimesS ?? null;
  const best = slow?.sectorBestS ?? null;

  const row = (idx: number) => {
    const key = SECTOR_KEYS[idx];
    const c = cur ? cur[key] : null;
    const b = best ? best[key] : null;
    const rawDelta = c != null && b != null ? c - b : null;
    // Bar and numeric text share one validity-gated value so they never disagree
    // (an out-lap artefact must not render a full bar next to a "--").
    const delta = validDelta(rawDelta);
    const displayDelta = delta;

    const color = delta == null ? t.textDim : Math.abs(delta) <= CLOSE_THRESHOLD_S ? t.amber : delta < 0 ? t.gain : t.loss;
    const frac = delta == null ? 0 : Math.max(-1, Math.min(1, delta / BAR_RANGE_S));
    const widthPct = Math.abs(frac) * 50;
    const gaining = delta != null && delta < 0;
    const leftPct = gaining ? 50 : 50 - widthPct;

    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* A subtle border (HighlightedDriver's cell pattern) — the cell fill
            alone (t.cell, 4% white) is too close to the panel color to read
            as a distinct chip even under the brightened theme. */}
        <div style={{ fontFamily: theme.font.label, width: "1.9em", textAlign: "center", padding: "3px 0", background: t.cell, border: `1px solid ${t.surfaceBorder}`, borderRadius: 7, boxSizing: "border-box", fontWeight: 700, fontSize: "0.72em", color: t.textDim, letterSpacing: "0.06em" }}>
          S{idx + 1}
        </div>
        <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color, width: "3.6em", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {fmtSecDelta(displayDelta, precision)}
        </span>
        <div style={{ position: "relative", flex: 1, height: "0.9em", borderRadius: "0.45em", background: "rgba(255,255,255,0.07)", overflow: "hidden", isolation: "isolate" }}>
          <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, background: "rgba(255,255,255,0.4)", transform: "translateX(-50%)" }} />
          <div
            style={{
              position: "absolute",
              top: 2,
              bottom: 2,
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              background: color,
              borderRadius: gaining ? "0 0.35em 0.35em 0" : "0.35em 0 0 0.35em",
              transition: "left 0.12s linear, width 0.12s linear",
              transform: "translateZ(0)",
              backfaceVisibility: "hidden",
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden", gap: theme.space.md }}>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center" }}>
        <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.78em", letterSpacing: "0.1em" }}>SECTOR DELTA</span>
      </div>
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", justifyContent: "center", gap: theme.space.md, minHeight: 0 }}>
        {SECTOR_KEYS.map((_, i) => row(i))}
      </div>
    </div>
  );
}

export const sectorDeltaDef: WidgetDefinition<SectorDeltaConfig> = {
  id: "sector-delta",
  name: "Sector Delta",
  defaultSize: { w: 240, h: 140 },
  minSize: { w: 180, h: 100 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["sectors"],
  configSchema: [
    {
      key: "precision",
      label: "Decimals",
      type: "enum",
      options: [
        { value: "1", label: "1" },
        { value: "2", label: "2" },
        { value: "3", label: "3" },
      ],
    },
  ],
  Component: SectorDelta,
};

function fmtSecDelta(s: number | null | undefined, precision: number): string {
  if (s == null || !isFinite(s)) return "--";
  return `${s >= 0 ? "+" : ""}${s.toFixed(precision)}`;
}
