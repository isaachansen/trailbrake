// Tachometer: the Dash Cluster shift-light strip on its own — Lovely per-car
// LED count / colors / per-gear RPM thresholds, flashing at redline. No gear,
// speed, or RPM text; those stay on the Dash widget.

import { useEffect, useMemo, useRef, useState } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useCarName } from "./useCarName";
import { resolveCarLeds } from "./carLeds";
import {
  FALLBACK_LED_COUNT,
  SHIFT_LED_SHAPE_OPTIONS,
  ShiftLedStrip,
  paintShiftLeds,
  type ShiftLedShape,
} from "./shiftLeds";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface TachometerConfig {
  /** Drive LEDs from bundled Lovely shift-light data when the live car matches. */
  useCarData: boolean;
  /** Fallback redline (RPM) when the car has no profile or useCarData is off. */
  redlineRpm: number;
  /** Visual shape of each shift light. */
  ledShape: ShiftLedShape;
}

const defaultConfig: TachometerConfig = {
  useCarData: true,
  redlineRpm: 8500,
  ledShape: "line",
};

function Tachometer({ theme, config }: BaseWidgetProps<TachometerConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const ledRefs = useRef<(HTMLDivElement | null)[]>([]);

  const carName = useCarName();
  const profile = useMemo(
    () => (config.useCarData ? resolveCarLeds(carName) : null),
    [carName, config.useCarData],
  );
  const ledCount = profile ? profile.ledCount : FALLBACK_LED_COUNT;
  const ledShape = config.ledShape ?? "line";

  // SDK shift-light thresholds from session YAML — change only on session/car
  // change, so subscribe narrowly to avoid re-renders on every slow tick.
  const [sdkRedline, setSdkRedline] = useState<number | null>(() => store.getSlow()?.driverCarRedline ?? null);
  const [sdkBlinkRpm, setSdkBlinkRpm] = useState<number | null>(() => store.getSlow()?.driverCarSlBlinkRpm ?? null);
  useEffect(() => {
    return store.subscribeSlow(() => {
      const slow = store.getSlow();
      setSdkRedline((prev) => { const v = slow?.driverCarRedline ?? null; return v !== prev ? v : prev; });
      setSdkBlinkRpm((prev) => { const v = slow?.driverCarSlBlinkRpm ?? null; return v !== prev ? v : prev; });
    });
  }, [store]);

  const live = useRef({ config, profile, ledCount, ledShape, sdkRedline, sdkBlinkRpm });
  live.current = { config, profile, ledCount, ledShape, sdkRedline, sdkBlinkRpm };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { config, profile, ledCount, ledShape, sdkRedline, sdkBlinkRpm } = live.current;
      const s = store.latestFast;
      const rpm = s?.rpm ?? 0;
      paintShiftLeds(
        ledRefs.current,
        ledCount,
        rpm,
        s?.gear,
        profile,
        config.redlineRpm,
        { accent: t.accent, throttle: t.throttle, loss: t.loss },
        ledShape,
        sdkRedline,
        sdkBlinkRpm,
      );
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store, t.accent, t.throttle, t.loss]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        padding: ledShape === "line" ? theme.widgetPad : "6px 8px",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <ShiftLedStrip ledCount={ledCount} shape={ledShape} ledRefs={ledRefs} style={{ width: "100%" }} />
    </div>
  );
}

export const tachometerDef: WidgetDefinition<TachometerConfig> = {
  id: "tachometer",
  name: "Tachometer",
  defaultSize: { w: 320, h: 52 },
  minSize: { w: 200, h: 40 },
  defaultConfig,
  // Reads store.latestFast (rpm/gear) plus the live car's name (slow, via
  // useCarName) to resolve its Lovely shift-light profile.
  requiredPaths: ["fast", "slow"],
  requiredCapabilities: [],
  configSchema: [
    { key: "useCarData", label: "Use car shift-light data", type: "boolean" },
    { key: "redlineRpm", label: "Redline (fallback)", type: "number", min: 4000, max: 15000, step: 100 },
    { key: "ledShape", label: "LED shape", type: "enum", options: [...SHIFT_LED_SHAPE_OPTIONS] },
  ],
  Component: Tachometer,
};
