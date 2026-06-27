import { useSlow } from "../store/hooks";
import { colorOf, fmtLapTime } from "./format";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface HighlightedDriverConfig {
  showCar: boolean;
  showLicense: boolean;
  showIrating: boolean;
  showBest: boolean;
}

const defaultConfig: HighlightedDriverConfig = {
  showCar: true,
  showLicense: true,
  showIrating: true,
  showBest: true,
};

function HighlightedDriver({ theme, config }: BaseWidgetProps<HighlightedDriverConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;

  const spectatedIdx = slow?.spectatedCarIdx ?? null;
  const playerIdx = slow?.playerCarIdx ?? null;
  const targetIdx = spectatedIdx ?? playerIdx;
  const car = slow?.cars.find((c) => c.carIdx === targetIdx) ?? null;
  const isSpectating = spectatedIdx != null && spectatedIdx !== playerIdx;

  if (!car) {
    return (
      <div style={{ fontFamily: theme.font.label, width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: t.textDim2, fontWeight: 600, fontSize: "0.7em", letterSpacing: "0.1em" }}>
        NO DRIVER
      </div>
    );
  }

  const classColor = colorOf(car.classColor, t.accent);
  const bestLap = car.bestLapS;
  const lastLap = car.lastLapS;

  const cellStyle = {
    flex: 1,
    minWidth: 0,
    textAlign: "center" as const,
    padding: `${theme.space.xs}px ${theme.space.xs}px`,
    background: t.cell,
    border: `1px solid ${t.surfaceBorder}`,
    borderRadius: 8,
    boxSizing: "border-box" as const,
  };
  const cellLabel = { fontFamily: theme.font.label, fontSize: "0.5em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2 } as const;
  const cellValue = { fontFamily: mono, fontWeight: 700, fontSize: "0.9em", fontVariantNumeric: "tabular-nums", lineHeight: 1.15, whiteSpace: "nowrap" as const } as const;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: theme.space.sm, padding: theme.widgetPad, boxSizing: "border-box", color: t.text }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: theme.space.md }}>
        <span style={{ width: 4, alignSelf: "stretch", borderRadius: 2, background: classColor, flex: "0 0 auto" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
          <span style={{ fontWeight: 800, fontSize: "1.1em", lineHeight: 1.1, color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {car.carNumber ? `#${car.carNumber} ` : ""}{car.driverName ?? "Unknown"}
          </span>
          {config.showCar && car.carScreenName && (
            <span style={{ fontSize: "0.66em", fontWeight: 500, color: t.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{car.carScreenName}</span>
          )}
        </div>
        {isSpectating && (
          <span style={{ fontFamily: theme.font.label, marginLeft: "auto", alignSelf: "center", fontWeight: 700, fontSize: "0.5em", letterSpacing: "0.1em", color: "#0a0b0e", background: t.amber, padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap", flex: "0 0 auto" }}>SPECTATING</span>
        )}
      </div>
      <div style={{ display: "flex", gap: theme.space.sm }}>
        {config.showBest && (
          <div style={cellStyle}>
            <div style={cellLabel}>BEST</div>
            <div style={{ ...cellValue, color: bestLap != null ? t.best : t.textDim2 }}>{fmtLapTime(bestLap)}</div>
          </div>
        )}
        <div style={cellStyle}>
          <div style={cellLabel}>LAST</div>
          <div style={{ ...cellValue, color: t.text }}>{fmtLapTime(lastLap)}</div>
        </div>
        <div style={cellStyle}>
          <div style={cellLabel}>POS</div>
          <div style={{ ...cellValue, color: car.position != null ? t.text : t.textDim2 }}>{car.position != null ? `P${car.position}` : "--"}</div>
        </div>
        {config.showIrating && car.irating != null && (
          <div style={cellStyle}>
            <div style={cellLabel}>iRT</div>
            <div style={{ ...cellValue, color: t.text }}>{car.irating.toLocaleString()}</div>
          </div>
        )}
      </div>
      {config.showLicense && car.safetyRating && (
        <div style={{ fontFamily: theme.font.label, fontSize: "0.62em", fontWeight: 600, letterSpacing: "0.04em", color: t.textDim }}>
          LICENSE {car.safetyRating} · CLASS {car.carClassName ?? "—"}
        </div>
      )}
    </div>
  );
}

export const highlightedDriverDef: WidgetDefinition<HighlightedDriverConfig> = {
  id: "highlighted-driver",
  name: "Highlighted Driver",
  defaultSize: { w: 340, h: 124 },
  minSize: { w: 260, h: 100 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["spectator"],
  configSchema: [
    { key: "showCar", label: "Show car", type: "boolean" },
    { key: "showLicense", label: "Show license", type: "boolean" },
    { key: "showIrating", label: "Show iRating", type: "boolean" },
    { key: "showBest", label: "Show best lap", type: "boolean" },
  ],
  Component: HighlightedDriver,
};
