import { useEffect, useMemo, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSlow } from "../store/hooks";
import { resolveCarLeds, gearLeds } from "./carLeds";
import { GEAR_COLOR_PRESETS } from "./raceColors";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface TachometerConfig {
  redlineRpm: number;
  shiftRpm: number;
  showRpmText: boolean;
  showGear: boolean;
  orientation: "horizontal" | "vertical";
  /** Color of the gear digit (hex). */
  gearColor: string;
}

const defaultConfig: TachometerConfig = {
  redlineRpm: 8500,
  shiftRpm: 8000,
  showRpmText: true,
  showGear: true,
  orientation: "horizontal",
  gearColor: "#ffffff",
};

function Tachometer({ theme, config }: BaseWidgetProps<TachometerConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const barRef = useRef<HTMLDivElement | null>(null);
  const rpmTextRef = useRef<HTMLSpanElement | null>(null);
  const gearRef = useRef<HTMLSpanElement | null>(null);

  // Resolve per-car shift profile the same way DashCluster does.
  const carName = useSlow()?.carName ?? null;
  const profile = useMemo(() => resolveCarLeds(carName), [carName]);

  const live = useRef({ config, profile });
  live.current = { config, profile };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { config, profile } = live.current;
      const fast = store.latestFast;
      const rpm = fast?.rpm ?? 0;
      const gear = fast?.gear ?? null;

      // Prefer per-car redline; fall back to user config.
      const gearData = profile ? gearLeds(profile, gear) : null;
      const redline = gearData?.redline ?? config.redlineRpm;
      const shiftRpm = config.shiftRpm;

      const frac = Math.max(0, Math.min(1, rpm / redline));
      const color = rpm >= redline ? t.loss : rpm >= shiftRpm ? t.amber : t.gain;
      if (barRef.current) {
        barRef.current.style.width = `${frac * 100}%`;
        barRef.current.style.background = color;
      }
      if (rpmTextRef.current) rpmTextRef.current.textContent = rpm > 0 ? String(Math.round(rpm)) : "--";
      if (gearRef.current) {
        const g = gear == null ? "--" : gear === 0 ? "N" : gear === -1 ? "R" : String(gear);
        gearRef.current.textContent = g;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store, t]);

  const vertical = config.orientation === "vertical";
  const sp = theme.space;
  const barRadius = sp.md; // 8 — matches sibling inner-cell rounding

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: vertical ? "row" : "column", alignItems: "stretch", justifyContent: "center", gap: vertical ? sp.lg : sp.md, padding: theme.widgetPad, boxSizing: "border-box", color: t.text, overflow: "hidden" }}>
      {config.showGear && (
        <div style={{ flex: "0 0 auto", display: "flex", flexDirection: vertical ? "column" : "row", alignItems: vertical ? "center" : "baseline", justifyContent: "center", gap: vertical ? 2 : sp.sm, minHeight: 0 }}>
          <span ref={gearRef} style={{ fontFamily: theme.font.family, fontWeight: 700, fontSize: "2.6em", color: config.gearColor ?? "#ffffff", lineHeight: 0.8, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>--</span>
          <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "0.62em", letterSpacing: "0.22em", color: t.textDim }}>GEAR</span>
        </div>
      )}

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: vertical ? "row" : "column", alignItems: "stretch", justifyContent: "center", gap: sp.xs }}>
        <div style={{ flex: vertical ? "1 1 auto" : "0 0 auto", width: vertical ? "auto" : "100%", height: vertical ? "100%" : "0.85em", minHeight: vertical ? 0 : "0.85em", borderRadius: barRadius, background: t.cell, overflow: "hidden", position: "relative", display: "flex", flexDirection: vertical ? "column-reverse" : "row" }}>
          <div ref={barRef} style={vertical ? { width: "100%", height: "0%", borderRadius: barRadius, transition: "height 0.05s linear, background 0.1s" } : { height: "100%", width: "0%", borderRadius: barRadius, transition: "width 0.05s linear, background 0.1s" }} />
        </div>
        {config.showRpmText && (
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "baseline", justifyContent: "center", gap: sp.xs }}>
            <span ref={rpmTextRef} style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "0.95em", color: t.text, fontVariantNumeric: "tabular-nums" }}>--</span>
            <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "0.6em", letterSpacing: "0.16em", color: t.textDim2 }}>RPM</span>
          </div>
        )}
      </div>
    </div>
  );
}

export const tachometerDef: WidgetDefinition<TachometerConfig> = {
  id: "tachometer",
  name: "Tachometer",
  defaultSize: { w: 280, h: 104 },
  minSize: { w: 180, h: 80 },
  defaultConfig,
  requiredPaths: ["fast"],
  requiredCapabilities: [],
  configSchema: [
    { key: "redlineRpm", label: "Redline (RPM)", type: "number", min: 3000, max: 20000, step: 100 },
    { key: "shiftRpm", label: "Shift point (RPM)", type: "number", min: 2000, max: 19000, step: 100 },
    { key: "showRpmText", label: "Show RPM text", type: "boolean" },
    { key: "showGear", label: "Show gear", type: "boolean" },
    { key: "orientation", label: "Orientation", type: "enum", options: [{ value: "horizontal", label: "Horizontal" }, { value: "vertical", label: "Vertical" }] },
    { key: "gearColor", label: "Gear color", type: "color", presets: GEAR_COLOR_PRESETS },
  ],
  Component: Tachometer,
};
