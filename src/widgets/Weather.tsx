import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { tempValue, tempLabel, speedValue, speedLabel } from "./format";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

// Small inline stroke-icon set for this widget, matching the manager's
// `icons.tsx` style (24x24 viewBox, stroke=currentColor, round caps/joins) —
// replaces the emoji glyphs, the only emoji iconography left in the family.
type WxIconName = "thermometer" | "flame" | "droplet" | "rain" | "percent";
const WX_PATHS: Record<WxIconName, React.ReactNode> = {
  thermometer: (
    <>
      <rect x="9.3" y="3" width="3.4" height="10.5" rx="1.7" />
      <circle cx="11" cy="17.5" r="3" />
      <line x1="11" y1="7" x2="11" y2="13.5" />
    </>
  ),
  flame: (
    <path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-2.9 1.8-4.9 3-7.3.2 2 1.2 2.9 2.1 2 .9-3.1-.3-5.7-2-7.5 3 .4 5.6 2.6 5.9 5.7.2 1.7-.5 2.6-1.4 3 1.7.5 3.9 2 3.9 4.6 0 3.2-2.6 5.7-5 5.7z" />
  ),
  droplet: <path d="M12 2.5C12 2.5 5.5 10.8 5.5 15.6a6.5 6.5 0 0 0 13 0C18.5 10.8 12 2.5 12 2.5Z" />,
  rain: (
    <>
      <path d="M7 15.5a4 4 0 0 1 .6-7.96A5.5 5.5 0 0 1 18.2 9.4a3.4 3.4 0 0 1-1 6.6H7Z" />
      <line x1="9" y1="18.5" x2="8" y2="21" />
      <line x1="13" y1="18.5" x2="12" y2="21" />
      <line x1="17" y1="18" x2="16" y2="20.5" />
    </>
  ),
  percent: (
    <>
      <circle cx="7" cy="7" r="2.4" />
      <circle cx="17" cy="17" r="2.4" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </>
  ),
};
function WxIcon({ name, size = "1em" }: { name: WxIconName; size?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline-block", verticalAlign: "-0.15em", flexShrink: 0 }} aria-hidden="true">
      {WX_PATHS[name]}
    </svg>
  );
}

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
  // Unknown direction must never default to pointing north — that reads as a
  // real reading. Keep it null so the arrow dims/hides instead.
  const windDeg = windDir != null && isFinite(windDir) ? (((windDir * 180) / Math.PI) % 360 + 360) % 360 : null;

  const wetness = slow?.trackWetnessPct ?? null;
  const precip = slow?.precipitationPct ?? null;
  const humidity = slow?.humidityPct ?? null;

  const statCell = (icon: WxIconName, label: string, value: React.ReactNode, color: string) => (
    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: t.cell, borderRadius: 9, minWidth: 0 }}>
      <span style={{ fontSize: "1.3em", lineHeight: 1, flexShrink: 0, color: t.textDim }}><WxIcon name={icon} /></span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: theme.font.label, fontSize: "0.56em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2 }}>{label}</div>
        <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color }}>{value}</div>
      </div>
    </div>
  );

  const barRow = (icon: WxIconName, label: string, frac: number | null, color: string) => {
    const pct = frac != null && isFinite(frac) ? Math.max(0, Math.min(100, frac * 100)) : null;
    return (
      <div key={label}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: theme.font.label, fontSize: "0.62em", fontWeight: 600, letterSpacing: "0.08em", color: t.textDim, whiteSpace: "nowrap" }}>
            <span style={{ marginRight: 5, color: t.textDim }}><WxIcon name={icon} /></span>
            {label}
          </span>
          <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "0.76em", color: t.text }}>
            {pct != null ? `${Math.round(pct)}%` : "--"}
          </span>
        </div>
        <div style={{ marginTop: 4, height: 6, borderRadius: 3, background: "rgba(128,128,128,0.25)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct ?? 0}%`, background: color, borderRadius: 3, transition: "width 0.3s linear" }} />
        </div>
      </div>
    );
  };

  const bars: React.ReactNode[] = [];
  if (config.showWetness) {
    bars.push(barRow("droplet", "WETNESS", wetness, `linear-gradient(90deg, ${t.clutch}, #9be8f5)`));
    bars.push(barRow("rain", "PRECIP", precip, "linear-gradient(90deg, #3d8bff, #8ab8ff)"));
  }
  if (config.showHumidity) {
    bars.push(barRow("percent", "HUMIDITY", humidity, `linear-gradient(90deg, ${t.clutch}, #6fe0d4)`));
  }

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: theme.space.sm, color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ flex: "0 0 auto" }}>
        <WidgetTitle title="Weather" theme={theme} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, flex: "0 0 auto" }}>
        {statCell("thermometer", "AIR", air != null ? `${Math.round(air)}${tLabel}` : "--", t.text)}
        {statCell("flame", "TRACK", track != null ? `${Math.round(track)}${tLabel}` : "--", t.amber)}
      </div>

      {config.showWind && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: t.cell, borderRadius: 9, flex: "0 0 auto" }}>
          <div style={{ width: "1.9em", height: "1.9em", borderRadius: "50%", border: `0.11em solid ${t.textDim}`, position: "relative", flexShrink: 0 }}>
            <div
              style={{
                position: "absolute",
                inset: 0,
                transform: windDeg != null ? `rotate(${windDeg}deg)` : undefined,
                display: "flex",
                justifyContent: "center",
                alignItems: "flex-start",
                paddingTop: 2,
                // No known direction → dim the arrow rather than let it sit at a
                // fabricated rotation (0deg would silently read as "north").
                opacity: windDeg != null ? 1 : 0.25,
              }}
            >
              <span style={{ fontSize: "0.7em", lineHeight: 1, color: windSpd != null && windDeg != null ? t.text : t.textDim2 }}>▲</span>
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
  minSize: { w: 200, h: 180 },
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
