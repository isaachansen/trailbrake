import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { tempValue, tempLabel, speedValue, speedLabel } from "./format";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface WeatherConfig {
  showWind: boolean;
  showWetness: boolean;
  showHumidity: boolean;
}

const defaultConfig: WeatherConfig = {
  showWind: true,
  showWetness: true,
  showHumidity: true,
};

function compassLabel(rad: number | null | undefined): string {
  if (rad == null || !isFinite(rad)) return "--";
  const deg = ((rad * 180) / Math.PI) % 360;
  const norm = ((deg % 360) + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(norm / 45) % 8];
}

function Weather({ theme, config }: BaseWidgetProps<WeatherConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;
  const units = useSettings().units;

  const tLabel = tempLabel(units);
  const wLabel = speedLabel(units);
  const air = tempValue(slow?.airTempC ?? null, units);
  const track = tempValue(slow?.trackTempC ?? null, units);
  const windSpd = speedValue(slow?.windSpeedMs ?? null, units);
  const windDir = slow?.windDirRad ?? null;
  const windDegRaw = windDir != null && isFinite(windDir) ? (windDir * 180) / Math.PI : 0;
  const windDeg = ((windDegRaw % 360) + 360) % 360;

  const wetness = slow?.trackWetnessPct ?? null;
  const precip = slow?.precipitationPct ?? null;
  const humidity = slow?.humidityPct ?? null;

  const statCell = (icon: string, label: string, value: React.ReactNode, color: string) => (
    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: t.cell, borderRadius: 9, minWidth: 0 }}>
      <span style={{ fontSize: "1.15em", lineHeight: 1, flexShrink: 0 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: theme.font.label, fontSize: "0.56em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2 }}>{label}</div>
        <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color }}>{value}</div>
      </div>
    </div>
  );

  const barRow = (icon: string, label: string, frac: number | null, color: string) => {
    const pct = frac != null && isFinite(frac) ? Math.max(0, Math.min(100, frac * 100)) : null;
    return (
      <div key={label}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: theme.font.label, fontSize: "0.62em", fontWeight: 600, letterSpacing: "0.08em", color: t.textDim, whiteSpace: "nowrap" }}>
            <span style={{ marginRight: 5 }}>{icon}</span>
            {label}
          </span>
          <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "0.76em", color: t.text }}>
            {pct != null ? `${Math.round(pct)}%` : "--"}
          </span>
        </div>
        <div style={{ marginTop: 4, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct ?? 0}%`, background: color, borderRadius: 3, transition: "width 0.3s linear" }} />
        </div>
      </div>
    );
  };

  const bars: React.ReactNode[] = [];
  if (config.showWetness) {
    bars.push(barRow("💧", "WETNESS", wetness, `linear-gradient(90deg, ${t.clutch}, #9be8f5)`));
    bars.push(barRow("🌧", "PRECIP", precip, "linear-gradient(90deg, #3d8bff, #8ab8ff)"));
  }
  if (config.showHumidity) {
    bars.push(barRow("💦", "HUMIDITY", humidity, `linear-gradient(90deg, ${t.clutch}, #6fe0d4)`));
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: theme.space.sm, color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ flex: "0 0 auto" }}>
        <WidgetTitle title="Weather" theme={theme} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, flex: "0 0 auto" }}>
        {statCell("🌡", "AIR", air != null ? `${Math.round(air)}${tLabel}` : "--", t.text)}
        {statCell("🔥", "TRACK", track != null ? `${Math.round(track)}${tLabel}` : "--", t.amber)}
      </div>

      {config.showWind && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: t.cell, borderRadius: 9, flex: "0 0 auto" }}>
          <div style={{ width: "1.9em", height: "1.9em", borderRadius: "50%", border: `0.11em solid ${t.textDim}`, position: "relative", flexShrink: 0 }}>
            <div style={{ position: "absolute", inset: 0, transform: `rotate(${windDeg}deg)`, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 2 }}>
              <span style={{ fontSize: "0.7em", lineHeight: 1, color: windSpd != null ? t.text : t.textDim2 }}>▲</span>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1, minWidth: 0 }}>
              <span style={{ fontFamily: theme.font.label, fontSize: "0.56em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2 }}>WIND</span>
              <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "0.8em", color: t.accent }}>{compassLabel(windDir)}</span>
            </div>
            <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color: t.text, whiteSpace: "nowrap" }}>
              {windSpd != null ? Math.round(windSpd) : "--"}
              <span style={{ fontSize: "0.62em", color: t.textDim, marginLeft: 4 }}>{wLabel}</span>
            </span>
          </div>
        </div>
      )}

      {bars.length > 0 && (
        <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-start", gap: theme.space.sm }}>
          {bars}
        </div>
      )}
    </div>
  );
}

export const weatherDef: WidgetDefinition<WeatherConfig> = {
  id: "weather",
  name: "Weather",
  defaultSize: { w: 280, h: 224 },
  minSize: { w: 200, h: 150 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["weather"],
  configSchema: [
    { key: "showWind", label: "Show wind", type: "boolean" },
    { key: "showWetness", label: "Show wetness", type: "boolean" },
    { key: "showHumidity", label: "Show humidity", type: "boolean" },
  ],
  Component: Weather,
};
