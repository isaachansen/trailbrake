// Traffic indicator: multiclass cars that are faster than you, or anyone
// lapping you (≥1 lap ahead). Vanishes when neither applies.
//
// "Faster" without per-car Speed: closing from behind, and/or a quicker
// best/rolling lap when both sides have honest times. Never fabricated.

import { useRef, useSyncExternalStore } from "react";
import { useSlow } from "../store/hooks";
import { useScreenLayer } from "../components/screenLayer";
import { editModeStore } from "../store/editMode";
import { classColorMap, classColorOf } from "./raceColors";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { CarEntry } from "../store/types";

export interface TrafficConfig {
  /** Only flag traffic within this many seconds. */
  rangeS: number;
}

const defaultConfig: TrafficConfig = { rangeS: 3 };

function paceS(c: CarEntry): number | null {
  if (c.rollingLapAvgS != null && c.rollingLapAvgS > 0) return c.rollingLapAvgS;
  if (c.bestLapS != null && c.bestLapS > 0) return c.bestLapS;
  return null;
}

function TrafficIndicator({ theme, config }: BaseWidgetProps<TrafficConfig>) {
  const t = theme.colors;
  const slow = useSlow();
  const editing = useSyncExternalStore(editModeStore.subscribe, editModeStore.get);
  const { preview } = useScreenLayer();
  const prev = useRef<{ idx: number; gap: number } | null>(null);

  const playerIdx = slow?.playerCarIdx ?? null;
  const range = config.rangeS;
  const player = slow?.cars.find((c) => c.isPlayer || c.carIdx === playerIdx) ?? null;
  const playerClass = player?.carClassId ?? null;
  const playerLap = player?.lap ?? null;
  const playerPace = player ? paceS(player) : null;

  const ccol = classColorMap(slow?.cars ?? []);

  let near: { idx: number; gap: number; cls: string; clsColor: string; kind: "class" | "lap" } | null = null;

  for (const c of slow?.cars ?? []) {
    if (c.inWorld === false || c.isPlayer || c.carIdx === playerIdx || c.gapToPlayerS == null) continue;
    if (c.onPitRoad === true) continue;
    const g = c.gapToPlayerS;
    if (Math.abs(g) > range) continue;

    const otherClass = playerClass != null && c.carClassId != null && c.carClassId !== playerClass;
    const lapping =
      playerLap != null && c.lap != null && c.lap >= playerLap + 1 && g < 0; // behind, a lap (or more) up

    let fasterClass = false;
    if (otherClass && g < 0) {
      const p = prev.current;
      const closing = p != null && p.idx === c.carIdx && Math.abs(g) < Math.abs(p.gap) - 0.001;
      const theirPace = paceS(c);
      const quickerPace =
        playerPace != null && theirPace != null && theirPace < playerPace - 0.05;
      // Only when we can prove they're faster — closing, or quicker lap pace.
      fasterClass = closing || quickerPace;
    }

    if (!fasterClass && !lapping) continue;

    if (!near || Math.abs(g) < Math.abs(near.gap)) {
      near = {
        idx: c.carIdx,
        gap: g,
        cls: c.carClassName ?? "",
        clsColor: classColorOf(ccol, c.carClassId),
        kind: lapping ? "lap" : "class",
      };
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

  const forceShow = editing || preview;
  if (!near && !forceShow) return null;

  const selfPanel = !editing && !preview;
  const behind = near != null && near.gap < 0;
  const urgent = near != null && Math.abs(near.gap) < 0.8;
  const accent = near == null ? t.gain : urgent ? t.loss : t.amber;
  const arrow = near == null ? "·" : behind ? "↓" : "↑";
  const msg =
    near == null
      ? "TRAFFIC"
      : near.kind === "lap"
        ? behind
          ? "LAPPING"
          : "LAP AHEAD"
        : behind
          ? "FASTER CLASS"
          : "CLASS AHEAD";
  const sub =
    near == null
      ? "NO TRAFFIC"
      : behind
        ? closing
          ? "DON'T DEFEND"
          : "HOLDING"
        : closing
          ? "CLOSING IN"
          : "HOLD YOUR LINE";
  const barPct = near == null ? 0 : Math.max(4, Math.min(100, (1 - Math.abs(near.gap) / range) * 100));

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: theme.space.lg,
        color: t.text,
        padding: theme.widgetPad,
        boxSizing: "border-box",
        overflow: "hidden",
        ...(selfPanel
          ? {
              background: t.surface,
              border: `1px solid ${t.surfaceBorder}`,
              borderRadius: theme.radius,
              backdropFilter: theme.panelBlur,
              WebkitBackdropFilter: theme.panelBlur,
              boxShadow: theme.panelShadow,
            }
          : null),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space.lg, minHeight: 0 }}>
        <div style={{ fontWeight: 700, fontSize: "2em", lineHeight: 1, color: accent, width: "1.1em", textAlign: "center" }}>{arrow}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: theme.space.sm }}>
            <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.68em", letterSpacing: "0.04em", color: "#0a0b0e", background: near ? near.clsColor : "#565c68", padding: "1px 7px", borderRadius: 5 }}>
              {near?.cls || "—"}
            </span>
            <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.05em", color: t.text, whiteSpace: "nowrap" }}>{msg}</span>
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
      <div style={{ flex: "0 0 auto", height: 5, borderRadius: 3, background: "rgba(128,128,128,0.25)", overflow: "hidden" }}>
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
  transparentPanel: () => true,
  Component: TrafficIndicator,
};
