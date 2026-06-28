import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface LaunchAssistConfig {
  clutchTarget: number;
  throttleTarget: number;
  showBrake: boolean;
}

const defaultConfig: LaunchAssistConfig = {
  clutchTarget: 0.6,
  throttleTarget: 0.5,
  showBrake: true,
};

function LaunchAssist({ theme, config }: BaseWidgetProps<LaunchAssistConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const clutchBar = useRef<HTMLDivElement | null>(null);
  const clutchVal = useRef<HTMLSpanElement | null>(null);
  const clutchMarker = useRef<HTMLDivElement | null>(null);
  const throttleBar = useRef<HTMLDivElement | null>(null);
  const throttleVal = useRef<HTMLSpanElement | null>(null);
  const throttleMarker = useRef<HTMLDivElement | null>(null);
  const brakeBar = useRef<HTMLDivElement | null>(null);
  const brakeVal = useRef<HTMLSpanElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const live = useRef({ config });
  live.current = { config };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { config } = live.current;
      const fast = store.latestFast;
      const speed = fast?.speedMs ?? 0;
      const stopped = speed < 2;

      if (root.current) root.current.style.opacity = stopped ? "1" : "0.15";

      const setBar = (bar: HTMLDivElement | null, val: HTMLSpanElement | null, v: number | null, target: number, color: string) => {
        const pct = v != null ? Math.max(0, Math.min(1, v)) * 100 : 0;
        if (bar) {
          bar.style.width = `${pct}%`;
          const within = v != null && Math.abs(v - target) < 0.02;
          bar.style.background = within ? t.gain : color;
        }
        if (val) val.textContent = v != null ? `${Math.round(v * 100)}%` : "--";
      };

      setBar(clutchBar.current, clutchVal.current, fast?.clutch ?? null, config.clutchTarget, t.clutch);
      setBar(throttleBar.current, throttleVal.current, fast?.throttle ?? null, config.throttleTarget, t.throttle);
      setBar(brakeBar.current, brakeVal.current, fast?.brake ?? null, 0, t.brake);

      if (clutchMarker.current) clutchMarker.current.style.left = `${config.clutchTarget * 100}%`;
      if (throttleMarker.current) throttleMarker.current.style.left = `${config.throttleTarget * 100}%`;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store, t]);

  const trackStyle: React.CSSProperties = {
    position: "relative",
    height: "1.15em",
    borderRadius: 8,
    background: "rgba(127,127,127,0.18)",
    boxShadow: "inset 0 0 0 1px rgba(127,127,127,0.28)",
    overflow: "hidden",
  };
  const fillBase: React.CSSProperties = {
    position: "absolute",
    top: 2,
    bottom: 2,
    left: 0,
    borderRadius: 6,
    transition: "width 0.05s linear, background 0.15s",
  };
  const markerStyle: React.CSSProperties = {
    position: "absolute",
    top: -2,
    bottom: -2,
    width: "0.15em",
    background: "#fff",
    transform: "translateX(-50%)",
    boxShadow: "0 0 4px rgba(255,255,255,0.8)",
  };
  const labelStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 4,
  };

  const channelLabel = (color: string): React.CSSProperties => ({
    fontFamily: theme.font.label,
    fontWeight: 600,
    fontSize: "0.62em",
    letterSpacing: "0.08em",
    color,
  });
  const valStyle: React.CSSProperties = {
    fontFamily: theme.font.mono,
    fontWeight: 700,
    fontSize: "0.82em",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div ref={root} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "12px 16px", boxSizing: "border-box", color: t.text, transition: "opacity 0.3s" }}>
      <div style={{ fontFamily: theme.font.label, textAlign: "center", fontWeight: 700, fontSize: "0.6em", letterSpacing: "0.14em", color: t.textDim, marginBottom: theme.space.xs }}>LAUNCH ASSIST</div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-evenly", gap: theme.space.md }}>
        <div>
          <div style={labelStyle}>
            <span style={channelLabel(t.clutch)}>CLUTCH</span>
            <span ref={clutchVal} style={valStyle}>--</span>
          </div>
          <div style={trackStyle}>
            <div ref={clutchBar} style={{ ...fillBase, background: t.clutch }} />
            <div ref={clutchMarker} style={markerStyle} />
          </div>
        </div>
        <div>
          <div style={labelStyle}>
            <span style={channelLabel(t.throttle)}>THROTTLE</span>
            <span ref={throttleVal} style={valStyle}>--</span>
          </div>
          <div style={trackStyle}>
            <div ref={throttleBar} style={{ ...fillBase, background: t.throttle }} />
            <div ref={throttleMarker} style={markerStyle} />
          </div>
        </div>
        {config.showBrake && (
          <div>
            <div style={labelStyle}>
              <span style={channelLabel(t.brake)}>BRAKE</span>
              <span ref={brakeVal} style={valStyle}>--</span>
            </div>
            <div style={trackStyle}>
              <div ref={brakeBar} style={{ ...fillBase, background: t.brake }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const launchAssistDef: WidgetDefinition<LaunchAssistConfig> = {
  id: "launch-assist",
  name: "Launch Assist",
  // Work in progress — hidden from the catalog in release builds (see contract).
  draft: true,
  defaultSize: { w: 200, h: 204 },
  minSize: { w: 140, h: 168 },
  defaultConfig,
  requiredPaths: ["fast"],
  requiredCapabilities: ["clutch"],
  configSchema: [
    { key: "clutchTarget", label: "Clutch target", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "throttleTarget", label: "Throttle target", type: "number", min: 0, max: 1, step: 0.01 },
    { key: "showBrake", label: "Show brake", type: "boolean" },
  ],
  Component: LaunchAssist,
};
