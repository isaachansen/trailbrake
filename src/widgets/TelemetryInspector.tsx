import type { CSSProperties } from "react";
import { useSlow } from "../store/hooks";
import { useStoreInstance } from "../store/storeContext";
import { speedValue, speedLabel, tempValue, tempLabel, fuelValue, fuelLabel } from "./format";
import { useSettings } from "../store/appSettings";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface TelemetryInspectorConfig {
  showFast: boolean;
  showSession: boolean;
  showCars: boolean;
  maxCars: number;
}

const defaultConfig: TelemetryInspectorConfig = {
  showFast: true,
  showSession: true,
  showCars: false,
  maxCars: 5,
};

function TelemetryInspector({ theme, config }: BaseWidgetProps<TelemetryInspectorConfig>) {
  const slow = useSlow();
  const store = useStoreInstance();
  const t = theme.colors;
  const mono = theme.font.mono;
  const units = useSettings().units;

  const fast = store.latestFast;
  const row = (label: string, value: string) => (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: theme.space.md,
        padding: "2px 0",
        borderBottom: `1px solid ${t.gridLine}`,
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: "0.6em",
          fontWeight: 500,
          color: t.textDim,
          letterSpacing: "0.01em",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: mono,
          fontSize: "0.62em",
          fontWeight: 600,
          color: t.text,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );

  const section: CSSProperties = {
    fontFamily: theme.font.label,
    fontSize: "0.52em",
    fontWeight: 700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: t.accent,
    margin: `${theme.space.xs}px 0 ${theme.space.xs}px`,
  };

  const spd = speedValue(fast?.speedMs ?? null, units);
  const airT = tempValue(slow?.airTempC ?? null, units);
  const trkT = tempValue(slow?.trackTempC ?? null, units);
  const fuel = fuelValue(slow?.fuelL ?? null, units);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: theme.space.sm,
        padding: theme.widgetPad,
        boxSizing: "border-box",
        color: t.text,
        background: t.surface,
        border: `1px solid ${t.surfaceBorder}`,
        borderRadius: theme.radius,
        backdropFilter: theme.panelBlur,
      }}
    >
      <WidgetTitle title="Telemetry Inspector" theme={theme} />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
      {config.showFast && fast && (
        <div>
          <div style={section}>Fast · {fast.readerHz.toFixed(0)}Hz · tick {fast.tick}</div>
          {row("speed", spd != null ? `${spd.toFixed(1)} ${speedLabel(units)}` : "--")}
          {row("rpm", fast.rpm != null ? fast.rpm.toFixed(0) : "--")}
          {row("gear", fast.gear != null ? String(fast.gear) : "--")}
          {row("throttle", fast.throttle != null ? fast.throttle.toFixed(3) : "--")}
          {row("brake", fast.brake != null ? fast.brake.toFixed(3) : "--")}
          {row("clutch", fast.clutch != null ? fast.clutch.toFixed(3) : "--")}
          {row("steering", fast.steeringRad != null ? `${fast.steeringRad.toFixed(3)}rad` : "--")}
          {row("lapDistPct", fast.lapDistPct != null ? fast.lapDistPct.toFixed(4) : "--")}
          {row("currentLapS", fast.currentLapS != null ? fast.currentLapS.toFixed(2) : "--")}
          {row("brakeBias", fast.brakeBiasPct != null ? fast.brakeBiasPct.toFixed(2) : "--")}
          {row("abs", fast.absActive != null ? String(fast.absActive) : "--")}
          {row("tc", fast.tcActive != null ? String(fast.tcActive) : "--")}
        </div>
      )}

      {config.showSession && slow && (
        <div>
          <div style={section}>Session</div>
          {row("sim", slow.sim)}
          {row("track", slow.trackName ?? "--")}
          {row("sessionType", slow.sessionType ?? "--")}
          {row("timeRemain", slow.timeRemainingS != null ? slow.timeRemainingS.toFixed(0) : "--")}
          {row("lapsRemain", slow.lapsRemaining != null ? String(slow.lapsRemaining) : "--")}
          {row("flagsRaw", slow.flagsRaw != null ? `0x${slow.flagsRaw.toString(16)}` : "--")}
          {row("airTemp", airT != null ? `${airT.toFixed(1)} ${tempLabel(units)}` : "--")}
          {row("trackTemp", trkT != null ? `${trkT.toFixed(1)} ${tempLabel(units)}` : "--")}
          {row("wind", slow.windSpeedMs != null ? `${slow.windSpeedMs.toFixed(1)}m/s` : "--")}
          {row("wetness", slow.trackWetnessPct != null ? `${(slow.trackWetnessPct * 100).toFixed(0)}%` : "--")}
          {row("precip", slow.precipitationPct != null ? `${(slow.precipitationPct * 100).toFixed(0)}%` : "--")}
          {row("humidity", slow.humidityPct != null ? `${(slow.humidityPct * 100).toFixed(0)}%` : "--")}
          {row("fuel", fuel != null ? `${fuel.toFixed(2)} ${fuelLabel(units)}` : "--")}
          {row("fuelPerLap", slow.fuelPerLapL != null ? slow.fuelPerLapL.toFixed(2) : "--")}
          {row("position", slow.position != null ? String(slow.position) : "--")}
          {row("spectated", slow.spectatedCarIdx != null ? String(slow.spectatedCarIdx) : "--")}
          {row("pitLimit", slow.pitSpeedLimitMs != null ? slow.pitSpeedLimitMs.toFixed(1) : "--")}
          {row("messages", String(slow.messages.length))}
          {row("cars", String(slow.cars.length))}
        </div>
      )}

      {config.showCars && slow && (
        <div>
          <div style={section}>Cars · first {config.maxCars}</div>
          {slow.cars.slice(0, config.maxCars).map((c) => (
            <div key={c.carIdx} style={{ padding: "3px 0", borderBottom: `1px solid ${t.gridLine}` }}>
              <div style={{ fontFamily: mono, fontSize: "0.6em", fontWeight: 600, color: c.isPlayer ? t.accent : t.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                #{c.carIdx} {c.driverName ?? "?"} {c.isPlayer ? "(you)" : ""}
              </div>
              <div style={{ fontFamily: mono, fontSize: "0.52em", color: t.textDim2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                pos={c.position ?? "--"} gap={c.gapToPlayerS?.toFixed(2) ?? "--"} lap={c.lap ?? "--"} pit={String(c.onPitRoad ?? false)} tyre={c.tyre ?? "--"}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

export const telemetryInspectorDef: WidgetDefinition<TelemetryInspectorConfig> = {
  id: "telemetry-inspector",
  name: "Telemetry Inspector",
  defaultSize: { w: 320, h: 420 },
  minSize: { w: 240, h: 200 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: [],
  configSchema: [
    { key: "showFast", label: "Show fast data", type: "boolean" },
    { key: "showSession", label: "Show session data", type: "boolean" },
    { key: "showCars", label: "Show cars", type: "boolean" },
    { key: "maxCars", label: "Max cars", type: "number", min: 1, max: 20, step: 1 },
  ],
  Component: TelemetryInspector,
};
