// Inputs: real pedal-trace treatment (filled throttle/brake areas + speed line),
// live vertical THR/BRK bars, and THR/BRK/CLU/STEER stat cells — matching the v2
// design.
//
// The fast-path reference widget. It NEVER re-renders via React on data: a single
// requestAnimationFrame loop reads `store.history` / `store.latestFast` directly,
// repaints the canvas, and pokes the bar heights + stat text through refs. It
// reports its measured FPS for the perf HUD.

import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSettings } from "../store/appSettings";
import { speedValue, speedLabel } from "./format";
import { GEAR_COLOR_PRESETS } from "./raceColors";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface InputGraphConfig {
  windowSeconds: number;
  showSpeed: boolean;
  showBars: boolean;
  showStats: boolean;
  /** Show the clutch trace line, bar, and stat cell. */
  showClutch: boolean;
  /** Show a gear + speed readout (like the Dash widget). */
  showGearSpeed: boolean;
  /** Color of the gear digit (hex). */
  gearColor: string;
}

const defaultConfig: InputGraphConfig = {
  windowSeconds: 6,
  showSpeed: true,
  showBars: true,
  showStats: true,
  showClutch: true,
  showGearSpeed: true,
  gearColor: "#ffffff",
};

/** Speed normalization ceiling (m/s ≈ 330 km/h) for the speed trace. */
const SPEED_MAX_MS = 92;

function InputGraph({ theme, config }: BaseWidgetProps<InputGraphConfig>) {
  const store = useStoreInstance();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const thrBar = useRef<HTMLDivElement | null>(null);
  const brkBar = useRef<HTMLDivElement | null>(null);
  const cluBar = useRef<HTMLDivElement | null>(null);
  const thrPct = useRef<HTMLDivElement | null>(null);
  const brkPct = useRef<HTMLDivElement | null>(null);
  const cluPct = useRef<HTMLDivElement | null>(null);
  const steerVal = useRef<HTMLDivElement | null>(null);
  const gearRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef<HTMLSpanElement | null>(null);

  const units = useSettings().units;
  const liveRef = useRef({ theme, config, units });
  liveRef.current = { theme, config, units };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let frames = 0;
    let lastFpsAt = performance.now();
    let cssW = 0;
    let cssH = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const { theme, config, units } = liveRef.current;
      const w = cssW;
      const h = cssH;
      ctx.clearRect(0, 0, w, h);

      const history = store.history;
      const latest = store.latestFast;

      // Layout: pedals occupy the top ~64%, the speed trace a lower band.
      const padTop = 4;
      const pedalBottom = config.showSpeed ? h * 0.64 : h - 4;
      const pedalH = Math.max(1, pedalBottom - padTop);

      // Gridlines across the pedal region.
      ctx.strokeStyle = theme.colors.gridLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) {
        const y = Math.round(padTop + (pedalH * i) / 4) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      if (latest && history.length > 1) {
        const tNow = latest.ts;
        const win = config.windowSeconds;
        const xOf = (ts: number) => w * (1 - (tNow - ts) / win);

        // Filled pedal area + stroke (the "real pedal input" look).
        const pedalArea = (key: "throttle" | "brake" | "clutch", fill: string, stroke: string) => {
          let started = false;
          ctx.beginPath();
          for (let i = 0; i < history.length; i++) {
            const s = history[i];
            const v = s[key];
            if (v == null) continue;
            const x = xOf(s.ts);
            const y = pedalBottom - clamp01(v) * pedalH;
            if (!started) {
              ctx.moveTo(x, pedalBottom);
              ctx.lineTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          if (!started) return;
          ctx.lineTo(w, pedalBottom);
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.fill();

          // Top stroke.
          ctx.beginPath();
          started = false;
          for (let i = 0; i < history.length; i++) {
            const s = history[i];
            const v = s[key];
            if (v == null) continue;
            const x = xOf(s.ts);
            const y = pedalBottom - clamp01(v) * pedalH;
            started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            started = true;
          }
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 2;
          ctx.lineJoin = "round";
          ctx.stroke();
        };

        pedalArea("throttle", withAlpha(theme.colors.throttle, 0.16), theme.colors.throttle);
        pedalArea("brake", withAlpha(theme.colors.brake, 0.15), theme.colors.brake);

        // Clutch as a solid line only (it sits at 0 most of the lap, so a filled
        // area would just be noise). Cyan, matching the CLU stat cell.
        if (config.showClutch) {
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < history.length; i++) {
            const s = history[i];
            if (s.clutch == null) continue;
            const x = xOf(s.ts);
            const y = pedalBottom - clamp01(s.clutch) * pedalH;
            started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            started = true;
          }
          ctx.strokeStyle = theme.colors.clutch;
          ctx.lineWidth = 2;
          ctx.lineJoin = "round";
          ctx.stroke();
        }

        // Speed line in the lower band.
        if (config.showSpeed) {
          const sTop = h * 0.72;
          const sH = Math.max(1, h - 8 - sTop);
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < history.length; i++) {
            const s = history[i];
            if (s.speedMs == null) continue;
            const x = xOf(s.ts);
            const y = sTop + sH - clamp01(s.speedMs / SPEED_MAX_MS) * sH;
            started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            started = true;
          }
          ctx.strokeStyle = theme.colors.clutch; // cyan = speed (design)
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // Poke DOM bars + stat cells from the same loop (no React re-render).
      if (latest) {
        if (thrBar.current) thrBar.current.style.height = `${Math.round(clamp01(latest.throttle ?? 0) * 100)}%`;
        if (brkBar.current) brkBar.current.style.height = `${Math.round(clamp01(latest.brake ?? 0) * 100)}%`;
        if (cluBar.current) cluBar.current.style.height = `${Math.round(clamp01(latest.clutch ?? 0) * 100)}%`;
        setText(thrPct.current, pct(latest.throttle));
        setText(brkPct.current, pct(latest.brake));
        setText(cluPct.current, pct(latest.clutch));
        setText(steerVal.current, latest.steeringRad == null ? "--" : `${Math.round((latest.steeringRad * 180) / Math.PI)}°`);

        // Gear + speed readout (same formatting as the Dash widget).
        setText(gearRef.current, latest.gear == null ? "N" : latest.gear < 0 ? "R" : latest.gear === 0 ? "N" : String(latest.gear));
        const sv = speedValue(latest.speedMs, units);
        setText(speedRef.current, sv == null ? "--" : String(Math.round(sv)));
      }

      frames++;
      const now = performance.now();
      if (now - lastFpsAt >= 500) {
        store.graphFps = (frames * 1000) / (now - lastFpsAt);
        frames = 0;
        lastFpsAt = now;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const barTrack: React.CSSProperties = {
    width: 10,
    height: "100%",
    background: theme.colors.cell,
    borderRadius: theme.space.xs,
    display: "flex",
    alignItems: "flex-end",
    overflow: "hidden",
  };
  const cell = (label: string, color: string, ref: React.RefObject<HTMLDivElement>, initial: string) => (
    <div style={{ flex: 1, textAlign: "center", padding: "5px 2px", background: theme.colors.cell, borderRadius: theme.space.md }}>
      <div ref={ref} style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "1.05em", color }}>{initial}</div>
      <div style={{ fontFamily: theme.font.label, fontSize: "0.6em", fontWeight: 600, letterSpacing: "0.12em", color: theme.colors.textDim2 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: theme.colors.text, padding: "9px 10px", boxSizing: "border-box" }}>
      {config.showGearSpeed && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 7, padding: "0 2px" }}>
          <div style={{ background: theme.colors.cell, borderRadius: theme.space.md, padding: "3px 12px", display: "grid", placeItems: "center" }}>
            <div ref={gearRef} style={{ fontFamily: theme.font.family, fontWeight: 800, fontSize: "2.1em", lineHeight: 0.85, color: config.gearColor ?? "#ffffff", minWidth: "0.6em", textAlign: "center" }}>N</div>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
            <span ref={speedRef} style={{ fontFamily: theme.font.family, fontWeight: 700, fontSize: "1.9em", lineHeight: 0.85, color: "#fff", fontVariantNumeric: "tabular-nums" }}>0</span>
            <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "0.62em", letterSpacing: "0.12em", color: theme.colors.textDim2 }}>{speedLabel(units)}</span>
          </div>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8 }}>
        {config.showBars && (
          <div style={{ display: "flex", gap: 5, padding: "2px 0 2px" }}>
            <div style={barTrack}>
              <div ref={thrBar} style={{ width: "100%", height: "0%", background: theme.colors.throttle, transition: "height .06s linear" }} />
            </div>
            <div style={barTrack}>
              <div ref={brkBar} style={{ width: "100%", height: "0%", background: theme.colors.brake, transition: "height .06s linear" }} />
            </div>
            {config.showClutch && (
              <div style={barTrack}>
                <div ref={cluBar} style={{ width: "100%", height: "0%", background: theme.colors.clutch, transition: "height .06s linear" }} />
              </div>
            )}
          </div>
        )}
        <div style={{ flex: 1, position: "relative", background: theme.colors.cell, borderRadius: theme.space.md, overflow: "hidden" }}>
          <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
        </div>
      </div>

      {config.showStats && (
        <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
          {cell("THR %", theme.colors.throttle, thrPct, "0")}
          {cell("BRK %", theme.colors.brake, brkPct, "0")}
          {config.showClutch && cell("CLU %", theme.colors.clutch, cluPct, "0")}
          {cell("STEER", theme.colors.text, steerVal, "0°")}
        </div>
      )}
    </div>
  );
}

export const inputGraphDef: WidgetDefinition<InputGraphConfig> = {
  id: "input-graph",
  name: "Inputs",
  defaultSize: { w: 380, h: 236 },
  minSize: { w: 220, h: 150 },
  defaultConfig,
  // Height tracks which stacked sections are on (design px @ scale 1): a base
  // (padding + pedal bars/graph) plus the gear+speed row, the speed-trace band,
  // and the stat-cell row. Sums to defaultSize.h (236) with everything enabled,
  // so toggling a section off makes the widget shorter instead of stretching the
  // graph. (showBars/showClutch change width/columns, not height.)
  contentHeight: (c) =>
    104 + (c.showGearSpeed ? 41 : 0) + (c.showSpeed ? 48 : 0) + (c.showStats ? 43 : 0),
  requiredPaths: ["fast"],
  requiredCapabilities: [],
  configSchema: [
    { key: "windowSeconds", label: "History (s)", type: "number", min: 2, max: 15, step: 1 },
    { key: "showGearSpeed", label: "Gear & speed", type: "boolean" },
    { key: "showSpeed", label: "Speed trace", type: "boolean" },
    { key: "showBars", label: "Pedal bars", type: "boolean" },
    { key: "showClutch", label: "Clutch", type: "boolean" },
    { key: "showStats", label: "Stat cells", type: "boolean" },
    { key: "gearColor", label: "Gear color", type: "color", presets: GEAR_COLOR_PRESETS },
  ],
  Component: InputGraph,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function pct(v: number | null | undefined): string {
  return v == null ? "--" : String(Math.round(clamp01(v) * 100));
}
function setText(el: HTMLElement | null, s: string) {
  if (el && el.textContent !== s) el.textContent = s;
}
/** Accept "#rrggbb" theme colors and apply an alpha for canvas fills. */
function withAlpha(color: string, a: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return color;
}
