import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface RejoinConfig {
  speedThresholdMs: number;
  careGapS: number;
  stopGapS: number;
}

const defaultConfig: RejoinConfig = {
  speedThresholdMs: 8.3,
  careGapS: 3.0,
  stopGapS: 1.5,
};

function RejoinIndicator({ theme, config }: BaseWidgetProps<RejoinConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const statusRef = useRef<HTMLDivElement | null>(null);
  const gapRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ config });
  live.current = { config };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { config } = live.current;
      const slow = store.getSlow();
      const fast = store.latestFast;
      const playerIdx = slow?.playerCarIdx ?? null;
      const onTrack = slow?.onTrack ?? true;
      const speed = fast?.speedMs ?? 0;

      let visible = onTrack && speed <= config.speedThresholdMs;
      let color = t.gain;
      let label = "CLEAR";
      let gapText = "--";

      if (visible) {
        let nearestBehindGap: number | null = null;
        for (const c of slow?.cars ?? []) {
          if (c.inWorld === false || c.isPlayer || c.carIdx === playerIdx) continue;
          if (c.onPitRoad === true) continue;
          const gap = c.gapToPlayerS;
          if (gap != null && gap < 0) {
            if (nearestBehindGap == null || Math.abs(gap) < Math.abs(nearestBehindGap)) {
              nearestBehindGap = Math.abs(gap);
            }
          }
        }
        if (nearestBehindGap == null) {
          color = t.gain;
          label = "CLEAR";
        } else {
          gapText = nearestBehindGap.toFixed(1) + "s";
          if (nearestBehindGap < config.stopGapS) {
            color = t.loss;
            label = "DO NOT REJOIN";
          } else if (nearestBehindGap < config.careGapS) {
            color = t.amber;
            label = "CAUTION";
          } else {
            color = t.gain;
            label = "CLEAR";
          }
        }
      }

      if (statusRef.current) {
        statusRef.current.style.background = color;
        // Remove the bar from layout flow when idle so it no longer occupies
        // its width + the flex gap, keeping the text block centered.
        statusRef.current.style.display = visible ? "block" : "none";
        statusRef.current.style.opacity = visible ? "1" : "0";
        // Crisp, color-tinted glow: a tight ambient halo rather than a diffuse
        // blur so the bar reads as a sharp, lit element on top of game footage.
        statusRef.current.style.boxShadow = `0 0 10px ${color}99`;
      }
      if (labelRef.current) {
        labelRef.current.style.opacity = visible ? "1" : "0";
        labelRef.current.textContent = label;
        labelRef.current.style.color = color;
      }
      if (gapRef.current) {
        gapRef.current.textContent = gapText;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store, t]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.9em", color: t.text, boxSizing: "border-box", padding: theme.widgetPad }}>
      <div ref={statusRef} style={{ width: "0.42em", height: "3.5em", borderRadius: "0.21em", background: t.gain, display: "none", opacity: 0, transition: "opacity 0.2s", flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.18em" }}>
        <div ref={labelRef} style={{ fontFamily: theme.font.label, fontWeight: 800, fontSize: "1.1em", letterSpacing: "0.08em", color: t.gain, opacity: 0, transition: "opacity 0.2s", lineHeight: 1 }}>CLEAR</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.4em" }}>
          <span ref={gapRef} style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "1.6em", color: t.text, lineHeight: 1 }}>--</span>
          <span style={{ fontFamily: theme.font.label, fontSize: "0.6em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim }}>GAP BEHIND</span>
        </div>
      </div>
    </div>
  );
}

export const rejoinDef: WidgetDefinition<RejoinConfig> = {
  id: "rejoin-indicator",
  name: "Rejoin Indicator",
  defaultSize: { w: 260, h: 120 },
  minSize: { w: 200, h: 90 },
  defaultConfig,
  requiredPaths: ["slow", "fast"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [
    { key: "speedThresholdMs", label: "Show below (m/s)", type: "number", min: 1, max: 30, step: 0.5 },
    { key: "careGapS", label: "Caution gap (s)", type: "number", min: 0.5, max: 10, step: 0.5 },
    { key: "stopGapS", label: "Stop gap (s)", type: "number", min: 0.3, max: 5, step: 0.3 },
  ],
  Component: RejoinIndicator,
};
