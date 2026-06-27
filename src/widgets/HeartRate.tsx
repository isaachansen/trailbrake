import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSlow } from "../store/hooks";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface HeartRateConfig {
  sessionId: string;
  widgetName: string;
}

const defaultConfig: HeartRateConfig = {
  sessionId: "",
  widgetName: "Bouncing_Heart_Widget",
};

function HeartRate({ config, size, theme }: BaseWidgetProps<HeartRateConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const slow = useSlow();
  const sid = config.sessionId.trim();
  const widget = config.widgetName.trim() || "Bouncing_Heart_Widget";
  const src = sid ? `https://app.hyperate.io/${widget}/${sid}` : "https://app.hyperate.io";

  // Heart rate is biometric, not a sim telemetry field — there's no real value to
  // show without a HypeRate device. So we only fabricate a BPM under the mock
  // source (`sim === "mock"`), which drives the manager previews and browser dev,
  // so the widget looks alive there. A real session uses the HypeRate iframe; a
  // real sim with no session still gets the setup hint (never fake biometric data
  // as if it were real).
  const mock = slow?.sim === "mock";
  const heartRef = useRef<HTMLDivElement | null>(null);
  const bpmRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!mock) return;
    let raf = 0;
    let last = 0;
    let beat = 0; // phase within one heartbeat, 0..1
    let bpm = 138;
    const start = performance.now();
    const draw = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      const tt = (now - start) / 1000;
      // Wander around a resting-under-load rate, nudged up by throttle/brake effort
      // so it tracks the driving in the mock lap.
      const fast = store.latestFast;
      const effort = fast ? Math.min(1, (fast.throttle ?? 0) * 0.5 + (fast.brake ?? 0) * 0.7) : 0.4;
      const targetBpm = 130 + 24 * effort + 5 * Math.sin(tt * 0.23);
      bpm += (targetBpm - bpm) * Math.min(1, dt * 0.7);

      // Advance the beat at the current rate and shape a quick "lub-dub" pulse.
      beat = (beat + dt * (bpm / 60)) % 1;
      const pulse = Math.exp(-beat * 11) + 0.55 * Math.exp(-((beat - 0.16) ** 2) * 90);
      const scale = 1 + Math.min(1, pulse) * 0.26;
      if (heartRef.current) heartRef.current.style.transform = `scale(${scale.toFixed(3)})`;
      if (bpmRef.current) {
        const v = String(Math.round(bpm));
        if (bpmRef.current.textContent !== v) bpmRef.current.textContent = v;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mock, store]);

  const minDim = Math.min(size.w, size.h);
  const heartPx = Math.max(28, Math.min(110, minDim * 0.38));
  const bpmPx = Math.max(20, Math.min(72, minDim * 0.26));
  const labelPx = Math.max(9, Math.min(22, bpmPx * 0.42));

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "transparent" }}>
      {sid ? (
        <iframe
          src={src}
          title="Heart Rate"
          allowTransparency
          style={{ width: size.w, height: size.h, border: "none", background: "transparent", pointerEvents: "none" }}
        />
      ) : mock ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: heartPx * 0.2 }}>
          <div ref={heartRef} style={{ transformOrigin: "center", willChange: "transform", filter: `drop-shadow(0 0 ${heartPx * 0.16}px ${t.accent}66)` }}>
            <svg width={heartPx} height={heartPx} viewBox="0 0 24 24" style={{ display: "block" }}>
              <path
                d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
                fill={t.accent}
              />
            </svg>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: bpmPx * 0.12 }}>
            <span ref={bpmRef} style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: bpmPx, lineHeight: 1, color: t.text, fontVariantNumeric: "tabular-nums" }}>138</span>
            <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: labelPx, letterSpacing: "0.14em", color: t.textDim }}>BPM</span>
          </div>
        </div>
      ) : (
        <div style={{ color: t.textDim, fontWeight: 600, fontSize: "0.7em", textAlign: "center", padding: 12 }}>
          Set your HypeRate session ID in settings.
          <br />
          <span style={{ fontSize: "0.8em", color: t.textDim2 }}>app.hyperate.io/&lt;sessionId&gt;</span>
        </div>
      )}
    </div>
  );
}

export const heartRateDef: WidgetDefinition<HeartRateConfig> = {
  id: "heart-rate",
  name: "Heart Rate",
  defaultSize: { w: 200, h: 200 },
  minSize: { w: 100, h: 100 },
  defaultConfig,
  requiredPaths: [],
  requiredCapabilities: [],
  configSchema: [
    { key: "sessionId", label: "HypeRate session ID", type: "enum", options: [{ value: "", label: "Enter in config…" }] },
    { key: "widgetName", label: "Widget style", type: "enum", options: [{ value: "Bouncing_Heart_Widget", label: "Bouncing Heart" }, { value: "Minimal", label: "Minimal" }, { value: "Pulse_Ring_Widget", label: "Pulse Ring" }] },
  ],
  Component: HeartRate,
};
