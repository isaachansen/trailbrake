import { useEffect, useMemo, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useCarName } from "./useCarName";
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
  const shiftMarkRef = useRef<HTMLDivElement | null>(null);
  const redlineMarkRef = useRef<HTMLDivElement | null>(null);

  // Resolve per-car shift profile the same way DashCluster does. Fast-path
  // widget — subscribe narrowly to just the car name (see useCarName) instead
  // of useSlow(), which would re-render on every slow-path tick.
  const carName = useCarName();
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

      // Prefer per-car redline; fall back to user config. The shift point is
      // derived from the car's last shift-light LED threshold (the point the
      // real dash tells you to change up) when a profile is known, so cars with
      // a lower redline show their amber band in the right place instead of
      // always using the config default.
      const gearData = profile ? gearLeds(profile, gear) : null;
      const redline = gearData?.redline ?? config.redlineRpm;
      const shiftRpm = gearData && gearData.leds.length > 0 ? gearData.leds[gearData.leds.length - 1] : config.shiftRpm;

      const frac = Math.max(0, Math.min(1, rpm / redline));
      const color = rpm >= redline ? t.loss : rpm >= shiftRpm ? t.amber : t.gain;
      if (barRef.current) {
        barRef.current.style.width = `${frac * 100}%`;
        barRef.current.style.background = color;
      }
      // Tick markers on the track itself, at the shift-point and redline
      // fractions (both relative to the redline the fill bar is normalized
      // against). The redline mark sits at the far end (frac 1) — always the
      // same edge as the track, but rendered explicitly so orientation changes
      // don't have to special-case it.
      const vertical = config.orientation === "vertical";
      const side = vertical ? "bottom" : "left";
      const shiftFrac = Math.max(0, Math.min(1, shiftRpm / redline));
      if (shiftMarkRef.current) shiftMarkRef.current.style.setProperty(side, `${shiftFrac * 100}%`);
      if (redlineMarkRef.current) redlineMarkRef.current.style.setProperty(side, "100%");
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
          {/* Shift-point and redline tick markers, positioned by the draw loop. */}
          <div
            ref={shiftMarkRef}
            style={
              vertical
                ? { position: "absolute", left: 0, right: 0, height: 2, bottom: "0%", transform: "translateY(50%)", background: "rgba(255,255,255,0.55)" }
                : { position: "absolute", top: 0, bottom: 0, width: 2, left: "0%", transform: "translateX(-50%)", background: "rgba(255,255,255,0.55)" }
            }
          />
          <div
            ref={redlineMarkRef}
            style={
              vertical
                ? { position: "absolute", left: 0, right: 0, height: 2, bottom: "0%", transform: "translateY(50%)", background: "rgba(255,255,255,0.85)" }
                : { position: "absolute", top: 0, bottom: 0, width: 2, left: "0%", transform: "translateX(-50%)", background: "rgba(255,255,255,0.85)" }
            }
          />
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
  // Reads store.latestFast (rpm/gear) plus the live car's name (slow, via
  // useCarName) to resolve its shift-light profile.
  requiredPaths: ["fast", "slow"],
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
