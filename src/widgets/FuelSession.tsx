// Fuel & Session: position / lap / time-left at a glance, a fuel-remaining bar,
// and the strategy trio — burn per lap, laps left in the tank, and the margin to
// the finish. Slow-path widget; re-renders only when the slow sample changes.
//
// "To finish" is the number that matters mid-race: liters in the tank minus what
// the remaining race needs. Positive (green) = you'll make it; negative (red) =
// you need to save or stop.

import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { fuelValue, fuelLabel } from "./format";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface FuelSessionConfig {
  /** Tank capacity (L) used to scale the remaining-fuel bar. */
  tankCapacityL: number;
  showSession: boolean;
  showStrategy: boolean;
}

const defaultConfig: FuelSessionConfig = {
  tankCapacityL: 60,
  showSession: true,
  showStrategy: true,
};

/** seconds → "m:ss" (clock style). */
function fmtClock(s: number | null | undefined): string {
  if (s == null || !isFinite(s) || s < 0) return "--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function FuelSession({ theme, config }: BaseWidgetProps<FuelSessionConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;

  const fuel = slow?.fuelL ?? null;
  const perLap = slow?.fuelPerLapL ?? null;
  const lapsLeftInTank = fuel != null && perLap != null && perLap > 0 ? Math.floor(fuel / perLap) : null;

  // Laps still to run: prefer an explicit count, else estimate from time left
  // and the last lap time.
  let lapsToFinish: number | null = slow?.lapsRemaining ?? null;
  if (lapsToFinish == null && slow?.timeRemainingS != null && slow?.lastLapS && slow.lastLapS > 0) {
    lapsToFinish = Math.ceil(slow.timeRemainingS / slow.lastLapS);
  }
  // Margin (L) at the flag: what's in the tank minus what the race still needs.
  const marginL = fuel != null && perLap != null && lapsToFinish != null ? fuel - lapsToFinish * perLap : null;

  const totalLap = slow?.lap != null && slow?.lapsRemaining != null ? slow.lap + slow.lapsRemaining : null;
  const fieldSize = slow?.cars.length || null;

  const barPct = fuel != null ? Math.max(0, Math.min(100, (fuel / config.tankCapacityL) * 100)) : 0;

  // Display fuel in the chosen units (the bar % above stays a unit-agnostic ratio).
  const units = useSettings().units;
  const fLabel = fuelLabel(units);
  const fuelDisp = fuelValue(fuel, units);
  const perLapDisp = fuelValue(perLap, units);
  const marginDisp = fuelValue(marginL, units);

  const cell = (label: string, value: React.ReactNode, color: string) => (
    <div style={{ flex: 1, minWidth: 0, textAlign: "center", padding: "7px 4px", background: t.cell, borderRadius: 9, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
      <div style={{ fontFamily: theme.font.label, fontSize: "0.58em", fontWeight: 600, letterSpacing: "0.12em", color: t.textDim2 }}>{label}</div>
      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", lineHeight: 1, color }}>{value}</div>
    </div>
  );
  const big = (v: React.ReactNode, suffix?: React.ReactNode) => (
    <span style={{ color: t.text }}>
      {v}
      {suffix != null && <span style={{ fontSize: "0.7em", color: t.textDim }}>{suffix}</span>}
    </span>
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: theme.space.md, color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ flex: "0 0 auto" }}>
        <WidgetTitle title="Fuel & Session" theme={theme} />
      </div>

      {config.showSession && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: theme.space.sm, flex: "1 1 0", minHeight: 0 }}>
          {cell("POSITION", big(slow?.position != null ? `P${slow.position}` : "--", fieldSize ? `/${fieldSize}` : null), t.text)}
          {cell("LAP", big(slow?.lap ?? "--", totalLap ? `/${totalLap}` : null), t.text)}
          {cell("TIME LEFT", fmtClock(slow?.timeRemainingS), t.amber)}
        </div>
      )}

      <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "0.7em", letterSpacing: "0.1em", color: t.textDim }}>FUEL REMAINING</span>
          <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color: t.text }}>
            {fuelDisp != null ? fuelDisp.toFixed(1) : "--"} <span style={{ fontSize: "0.68em", color: t.textDim }}>{fLabel}</span>
          </span>
        </div>
        <div style={{ marginTop: 9, height: "0.65em", borderRadius: 5, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${barPct}%`, background: `linear-gradient(90deg, ${t.amber}, #ffd98a)`, borderRadius: 5, transition: "width 0.4s linear" }} />
        </div>
      </div>

      {config.showStrategy && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: theme.space.sm, flex: "1 1 0", minHeight: 0 }}>
          {cell("PER LAP", perLapDisp != null ? big(perLapDisp.toFixed(2), ` ${fLabel}`) : "--", t.text)}
          {cell(
            "LAPS LEFT",
            lapsLeftInTank != null ? String(lapsLeftInTank) : "--",
            // Only warn (red) / reassure (green) when we know the finish target;
            // without it, "laps left in the tank" is just a neutral fact.
            lapsLeftInTank == null || lapsToFinish == null ? t.text : lapsLeftInTank >= lapsToFinish ? t.gain : t.loss
          )}
          {cell(
            "TO FIN",
            marginDisp != null ? big(`${marginDisp >= 0 ? "+" : ""}${marginDisp.toFixed(1)}`, ` ${fLabel}`) : "--",
            marginDisp == null ? t.text : marginDisp >= 0 ? t.gain : t.loss
          )}
        </div>
      )}
    </div>
  );
}

export const fuelSessionDef: WidgetDefinition<FuelSessionConfig> = {
  id: "fuel-session",
  name: "Fuel & Session",
  defaultSize: { w: 340, h: 230 },
  minSize: { w: 240, h: 110 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["fuel"],
  configSchema: [
    { key: "tankCapacityL", label: "Tank (L)", type: "number", min: 20, max: 140, step: 1 },
    { key: "showSession", label: "Session row", type: "boolean" },
    { key: "showStrategy", label: "Strategy row", type: "boolean" },
  ],
  Component: FuelSession,
};
