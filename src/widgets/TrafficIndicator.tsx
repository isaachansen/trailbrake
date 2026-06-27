// Traffic indicator: the single nearest car within a few seconds, with which
// way it is (ahead / behind), its class, the gap, and whether it's closing. The
// "get out of the way / don't defend" glance for multiclass traffic.
//
// Derived from the field: nearest car by |gapToPlayerS| within range; closing is
// inferred from the gap shrinking between updates. Slow-path widget.

import { useRef } from "react";
import { useSlow } from "../store/hooks";
import { colorOf } from "./format";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface TrafficConfig {
  /** Only flag traffic within this many seconds. */
  rangeS: number;
}

const defaultConfig: TrafficConfig = { rangeS: 3 };

function TrafficIndicator({ theme, config }: BaseWidgetProps<TrafficConfig>) {
  const t = theme.colors;
  const slow = useSlow();
  const prev = useRef<{ idx: number; gap: number } | null>(null);

  const playerIdx = slow?.playerCarIdx ?? null;
  const range = config.rangeS;

  // Nearest neighbour within range.
  let near: { idx: number; gap: number; cls: string; clsColor: string } | null = null;
  for (const c of slow?.cars ?? []) {
    if (c.inWorld === false || c.isPlayer || c.carIdx === playerIdx || c.gapToPlayerS == null) continue;
    const g = c.gapToPlayerS;
    if (Math.abs(g) > range) continue;
    if (!near || Math.abs(g) < Math.abs(near.gap)) {
      near = { idx: c.carIdx, gap: g, cls: c.carClassName ?? "", clsColor: colorOf(c.classColor, "#565c68") };
    }
  }

  let closing = false;
  if (near) {
    const p = prev.current;
    if (p && p.idx === near.idx) closing = Math.abs(near.gap) < Math.abs(p.gap) - 0.001;
    prev.current = { idx: near.idx, gap: near.gap };
  } else {
    prev.current = null;
  }

  const behind = near != null && near.gap < 0; // negative gap = behind on track-time
  const urgent = near != null && Math.abs(near.gap) < 0.8;
  const accent = near == null ? t.gain : urgent ? t.loss : t.amber;
  // Ahead = up (car is in front of you), behind = down.
  const arrow = near == null ? "✓" : behind ? "↓" : "↑";
  const msg = near == null ? "TRACK CLEAR" : behind ? "CAR BEHIND" : "CAR AHEAD";
  const sub = near == null ? "NO TRAFFIC IN RANGE" : behind ? (closing ? "DON'T DEFEND" : "HOLDING") : closing ? "CLOSING IN" : "HOLD YOUR LINE";
  const barPct = near == null ? 0 : Math.max(4, Math.min(100, (1 - Math.abs(near.gap) / range) * 100));

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: theme.space.lg, color: t.text, padding: "11px 14px", boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13, minHeight: 0 }}>
        <div style={{ fontWeight: 700, fontSize: "2em", lineHeight: 1, color: accent, width: "1.1em", textAlign: "center" }}>{arrow}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.68em", letterSpacing: "0.04em", color: "#0a0b0e", background: near ? near.clsColor : "#565c68", padding: "1px 7px", borderRadius: 5 }}>{near?.cls || "—"}</span>
            <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.05em", color: "#fff", whiteSpace: "nowrap" }}>{msg}</span>
          </div>
          <div style={{ fontFamily: theme.font.label, marginTop: 5, fontWeight: 600, fontSize: "0.62em", letterSpacing: "0.08em", color: t.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {near ? (
              <>
                {closing ? "CLOSING " : "GAP "}
                <span style={{ color: accent, fontFamily: theme.font.mono }}>{Math.abs(near.gap).toFixed(1)}s</span>
                {" · "}
                {sub}
              </>
            ) : (
              sub
            )}
          </div>
        </div>
      </div>
      <div style={{ flex: "0 0 auto", height: 5, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${barPct}%`, background: accent, borderRadius: 3, transition: "width 0.2s linear" }} />
      </div>
    </div>
  );
}

export const trafficDef: WidgetDefinition<TrafficConfig> = {
  id: "traffic",
  name: "Traffic Indicator",
  defaultSize: { w: 316, h: 92 },
  minSize: { w: 220, h: 70 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [{ key: "rangeS", label: "Range (s)", type: "number", min: 1, max: 8, step: 0.5 }],
  Component: TrafficIndicator,
};
