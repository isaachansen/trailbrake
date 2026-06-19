// Spotter: minimal "car alongside" edge bars. The left/right bar lights when a
// car is beside you on that side; "3 WIDE" shows when both. Same proximity data
// as the Radar (relLatM/relLonM), but stripped to the one glance that matters
// mid-corner. rAF loop pokes the bar opacity through refs — no React re-render.

import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface SpotterConfig {
  /** Longitudinal window (m) within which a neighbour counts as alongside. */
  alongsideM: number;
}

const defaultConfig: SpotterConfig = { alongsideM: 3 };

function Spotter({ theme, config }: BaseWidgetProps<SpotterConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const wideRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ config });
  live.current = { config };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { config } = live.current;
      const slow = store.getSlow();
      const playerIdx = slow?.playerCarIdx ?? null;
      let warnL = false;
      let warnR = false;
      for (const c of slow?.cars ?? []) {
        if (c.isPlayer || c.carIdx === playerIdx || c.relLatM == null || c.relLonM == null) continue;
        if (Math.abs(c.relLonM) < config.alongsideM) {
          if (c.relLatM < 0) warnL = true;
          else warnR = true;
        }
      }
      if (leftRef.current) leftRef.current.style.opacity = warnL ? "1" : "0.12";
      if (rightRef.current) rightRef.current.style.opacity = warnR ? "1" : "0.12";
      if (wideRef.current) wideRef.current.style.display = warnL && warnR ? "block" : "none";
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  const bar: React.CSSProperties = {
    width: 18,
    height: "100%",
    borderRadius: 7,
    background: t.loss,
    opacity: 0.12,
    boxShadow: `0 0 20px ${t.loss}`,
    transition: "opacity 0.12s",
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "16px 16px 12px", boxSizing: "border-box" }}>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 16, minHeight: 0 }}>
        <div ref={leftRef} style={bar} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
          <div style={{ width: 32, height: 58, borderRadius: 8, background: t.accent, boxShadow: "0 0 18px rgba(255,45,142,0.55)" }} />
          <div ref={wideRef} style={{ fontWeight: 700, fontSize: "0.7em", letterSpacing: "0.16em", color: t.amber, display: "none" }}>3 WIDE</div>
        </div>
        <div ref={rightRef} style={bar} />
      </div>
      <div style={{ textAlign: "center", marginTop: 6, fontWeight: 600, fontSize: "0.58em", letterSpacing: "0.18em", color: t.textDim2 }}>CAR ALONGSIDE</div>
    </div>
  );
}

export const spotterDef: WidgetDefinition<SpotterConfig> = {
  id: "spotter",
  name: "Spotter",
  defaultSize: { w: 236, h: 200 },
  minSize: { w: 150, h: 150 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["proximity"],
  configSchema: [{ key: "alongsideM", label: "Alongside (m)", type: "number", min: 1, max: 8, step: 0.5 }],
  Component: Spotter,
};
