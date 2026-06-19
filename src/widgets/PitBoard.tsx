// Pit board: the stop plan at a glance — how much fuel to add to reach the flag,
// laps left in the tank, current tyre, and a pit-limiter / box state. Slow-path.
//
// Honest about what the sim actually gives us: fuel maths are real (remaining,
// per-lap, laps-to-finish); tyre is the player's current compound; the limiter
// reads `onPitRoad`. Things the model can't know (corner-by-corner tyre choice,
// estimated stop time, rejoin position) are intentionally left out rather than faked.

import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { fuelValue, fuelLabel } from "./format";
import { TyreBadge } from "./TyreBadge";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface PitBoardConfig {
  /** Tank capacity (L) — fuel-to-add can't exceed what fits. */
  tankCapacityL: number;
  showStrategy: boolean;
}

const defaultConfig: PitBoardConfig = { tankCapacityL: 60, showStrategy: true };

function PitBoard({ theme, config }: BaseWidgetProps<PitBoardConfig>) {
  const t = theme.colors;
  const mono = theme.font.mono;
  const slow = useSlow();

  const player = slow?.cars.find((c) => c.isPlayer || c.carIdx === slow?.playerCarIdx) ?? null;
  const fuel = slow?.fuelL ?? null;
  const perLap = slow?.fuelPerLapL ?? null;
  const lapsLeftInTank = fuel != null && perLap != null && perLap > 0 ? Math.floor(fuel / perLap) : null;

  let lapsToFinish: number | null = slow?.lapsRemaining ?? null;
  if (lapsToFinish == null && slow?.timeRemainingS != null && slow?.lastLapS && slow.lastLapS > 0) {
    lapsToFinish = Math.ceil(slow.timeRemainingS / slow.lastLapS);
  }
  // Fuel needed to reach the flag, beyond what's in the tank (clamped to capacity).
  const fuelToAdd =
    fuel != null && perLap != null && lapsToFinish != null
      ? Math.max(0, Math.min(config.tankCapacityL - fuel, lapsToFinish * perLap - fuel))
      : null;
  const stopNeeded = fuelToAdd != null && fuelToAdd > 0.05;
  const onPit = player?.onPitRoad === true;
  const tyre = player?.tyre ?? null;

  // Display fuel in the chosen units (the maths above are all in liters).
  const units = useSettings().units;
  const fLabel = fuelLabel(units);
  const fuelToAddDisp = fuelValue(fuelToAdd, units);
  const fuelDisp = fuelValue(fuel, units);
  const perLapDisp = fuelValue(perLap, units);

  const cell = (label: string, value: React.ReactNode, color: string) => (
    <div style={{ padding: "8px 11px", background: t.cell, borderRadius: 9, minWidth: 0 }}>
      <div style={{ fontSize: "0.5em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2 }}>{label}</div>
      <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.15em", color }}>{value}</div>
    </div>
  );
  const unit = (s: string) => <span style={{ fontSize: "0.6em", color: t.textDim }}> {s}</span>;

  const corner = (label: string) => (
    <div style={{ flex: 1, textAlign: "center", padding: "5px 0", background: t.cell, borderRadius: 7 }}>
      <div style={{ fontSize: "0.46em", fontWeight: 600, letterSpacing: "0.08em", color: t.textDim2 }}>{label}</div>
      <div style={{ margin: "3px auto 0", display: "flex", justifyContent: "center" }}>
        <TyreBadge compound={tyre} size="1.5em" />
      </div>
    </div>
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "8px 12px 12px", boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>PIT BOARD</span>
        <span style={{ marginLeft: "auto", fontWeight: 600, fontSize: "0.6em", letterSpacing: "0.06em", color: onPit ? t.amber : t.textDim2 }}>
          {onPit ? "● ON PIT ROAD" : "● RACING"}
        </span>
      </div>

      <div style={{ padding: "9px 13px", borderRadius: 11, background: stopNeeded ? "rgba(255,180,61,0.14)" : t.cell, border: stopNeeded ? `1px solid rgba(255,180,61,0.35)` : `1px solid ${t.surfaceBorder}`, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontWeight: 700, fontSize: "1.3em", letterSpacing: "0.03em", color: stopNeeded ? t.amber : t.gain }}>
          {fuelToAdd == null ? "—" : stopNeeded ? "STOP FOR FUEL" : "FUEL OK"}
        </span>
        {slow?.lapsRemaining != null && (
          <span style={{ marginLeft: "auto", fontWeight: 600, fontSize: "0.62em", letterSpacing: "0.08em", color: t.textDim }}>{slow.lapsRemaining} LAPS LEFT</span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 11 }}>
        {cell("FUEL TO ADD", fuelToAddDisp == null ? "--" : <>{fuelToAddDisp.toFixed(1)}{unit(fLabel)}</>, "#fff")}
        {cell("LAPS IN TANK", lapsLeftInTank == null ? "--" : String(lapsLeftInTank), lapsLeftInTank != null && lapsToFinish != null && lapsLeftInTank >= lapsToFinish ? t.gain : t.loss)}
      </div>

      {tyre && (
        <div style={{ display: "flex", gap: 6, marginTop: 9, alignItems: "stretch" }}>
          <span style={{ fontSize: "0.5em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2, alignSelf: "center", width: "3em" }}>TYRES</span>
          <div style={{ flex: 1, display: "flex", gap: 5 }}>
            {corner("LF")}
            {corner("RF")}
            {corner("LR")}
            {corner("RR")}
          </div>
        </div>
      )}

      {config.showStrategy && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 9 }}>
          {cell("FUEL NOW", fuelDisp == null ? "--" : <>{fuelDisp.toFixed(1)}{unit(fLabel)}</>, t.text)}
          <div style={{ padding: "8px 11px", background: t.cell, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: "0.5em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2 }}>PER LAP</div>
              <div style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.15em", color: "#fff" }}>{perLapDisp == null ? "--" : perLapDisp.toFixed(2)}{unit(fLabel)}</div>
            </div>
            {onPit && <span style={{ fontWeight: 700, fontSize: "0.55em", letterSpacing: "0.06em", color: "#0a0b0e", background: t.amber, padding: "2px 7px", borderRadius: 5 }}>LIMITER</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export const pitBoardDef: WidgetDefinition<PitBoardConfig> = {
  id: "pit",
  name: "Pit Board",
  defaultSize: { w: 360, h: 240 },
  minSize: { w: 240, h: 130 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["fuel"],
  configSchema: [
    { key: "tankCapacityL", label: "Tank (L)", type: "number", min: 20, max: 140, step: 1 },
    { key: "showStrategy", label: "Strategy row", type: "boolean" },
  ],
  Component: PitBoard,
};
