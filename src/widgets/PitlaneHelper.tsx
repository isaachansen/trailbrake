import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { speedValue, speedLabel } from "./format";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface PitlaneHelperConfig {
  showSpeedBar: boolean;
  showCountdown: boolean;
  showTraffic: boolean;
}

const defaultConfig: PitlaneHelperConfig = {
  showSpeedBar: true,
  showCountdown: true,
  showTraffic: true,
};

function PitlaneHelper({ theme, config }: BaseWidgetProps<PitlaneHelperConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;
  const units = useSettings().units;

  const onPitRoad = slow?.cars.find((c) => c.isPlayer)?.onPitRoad ?? false;
  const speedLimit = slow?.pitSpeedLimitMs ?? null;
  const boxDist = slow?.pitBoxDistM ?? null;
  const playerIdx = slow?.playerCarIdx ?? null;

  let carsAhead = 0;
  let carsBehind = 0;
  for (const c of slow?.cars ?? []) {
    if (c.isPlayer || c.carIdx === playerIdx) continue;
    if (c.onPitRoad !== true) continue;
    if (c.gapToPlayerS != null) {
      if (c.gapToPlayerS > 0) carsAhead++;
      else if (c.gapToPlayerS < 0) carsBehind++;
    }
  }

  const limitDisp = speedValue(speedLimit, units);
  const limitLabel = speedLabel(units);

  const speedColor = onPitRoad ? t.gain : t.text;
  const sp = theme.space;

  const labelStyle = {
    fontFamily: theme.font.label,
    fontSize: "0.52em",
    fontWeight: 600,
    letterSpacing: "0.1em",
    color: t.textDim2,
  } as const;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: sp.md, padding: theme.widgetPad, boxSizing: "border-box", color: t.text }}>
      <WidgetTitle
        title="Pit Lane"
        theme={theme}
        right={
          <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.55em", letterSpacing: "0.08em", color: onPitRoad ? "#0a0b0e" : t.textDim2, background: onPitRoad ? t.amber : "transparent", padding: "2px 8px", borderRadius: 4 }}>
            {onPitRoad ? "IN PITS" : "ON TRACK"}
          </span>
        }
      />

      {config.showSpeedBar && speedLimit != null && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={labelStyle}>SPEED LIMIT</span>
            <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color: speedColor, fontVariantNumeric: "tabular-nums" }}>
              {limitDisp != null ? Math.round(limitDisp) : "--"} <span style={{ fontSize: "0.6em", color: t.textDim, letterSpacing: "0.04em" }}>{limitLabel}</span>
            </span>
          </div>
          <div style={{ marginTop: sp.xs, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: "100%", background: `linear-gradient(90deg, ${t.gain}, ${t.amber}, ${t.loss})`, borderRadius: 3, opacity: onPitRoad ? 1 : 0.3 }} />
          </div>
        </div>
      )}

      {config.showCountdown && (
        <div style={{ display: "flex", gap: sp.md, flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: sp.xs, padding: `${sp.xs}px ${sp.sm}px`, background: t.cell, borderRadius: theme.radius / 2 }}>
            <div style={labelStyle}>BOX DIST</div>
            <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", lineHeight: 1, fontVariantNumeric: "tabular-nums", color: boxDist != null ? (Math.abs(boxDist) < 5 ? t.gain : t.amber) : t.textDim }}>
              {boxDist != null ? `${boxDist >= 0 ? "+" : ""}${Math.round(boxDist)}m` : "--"}
            </div>
          </div>
          {config.showTraffic && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: sp.xs, padding: `${sp.xs}px ${sp.sm}px`, background: t.cell, borderRadius: theme.radius / 2 }}>
              <div style={labelStyle}>TRAFFIC</div>
              <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", lineHeight: 1, fontVariantNumeric: "tabular-nums", color: t.text, display: "flex", gap: sp.md }}>
                <span><span style={{ color: t.textDim, fontWeight: 600 }}>↑</span>{carsAhead}</span>
                <span><span style={{ color: t.textDim, fontWeight: 600 }}>↓</span>{carsBehind}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const pitlaneHelperDef: WidgetDefinition<PitlaneHelperConfig> = {
  id: "pitlane-helper",
  name: "Pitlane Helper",
  defaultSize: { w: 260, h: 160 },
  minSize: { w: 200, h: 120 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["pitInfo"],
  configSchema: [
    { key: "showSpeedBar", label: "Speed limit bar", type: "boolean" },
    { key: "showCountdown", label: "Box countdown", type: "boolean" },
    { key: "showTraffic", label: "Pit traffic", type: "boolean" },
  ],
  Component: PitlaneHelper,
};
