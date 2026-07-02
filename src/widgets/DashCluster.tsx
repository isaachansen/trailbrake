// Dash cluster: the at-a-glance driving readout — an RPM shift-light strip, big
// gear, speed, an optional mini throttle/brake trace, and a live steering wheel.
// RPM-vs-redline is shown once, by the shift lights (no separate redline bar).
//
// Fast-path widget (like the Input graph): it never re-renders via React on
// telemetry. A single requestAnimationFrame loop reads `store.latestFast` /
// `store.history`, repaints the mini trace, and pokes the gear/speed text, LED
// colors and wheel rotation straight into the DOM through refs — so it tracks the
// physics rate without stuttering React.

import { useEffect, useMemo, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSettings } from "../store/appSettings";
import { useCarName } from "./useCarName";
import { speedValue, speedLabel } from "./format";
import { resolveCarLeds, gearLeds } from "./carLeds";
import { GEAR_COLOR_PRESETS } from "./raceColors";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface DashClusterConfig {
  /** Fallback redline (RPM) used when the live car has no shift-light profile,
   *  or when "Use car data" is off. */
  redlineRpm: number;
  /** Drive the rev lights from the bundled per-car shift-light data when the live
   *  car is recognized (real LED count / thresholds / colors per gear). */
  useCarData: boolean;
  showLeds: boolean;
  /** A compact throttle/brake trace in the center. */
  showInputs: boolean;
  showSteering: boolean;
  /** Color of the gear digit (hex). */
  gearColor: string;
}

const defaultConfig: DashClusterConfig = {
  redlineRpm: 8500,
  useCarData: true,
  showLeds: true,
  showInputs: false,
  showSteering: true,
  gearColor: "#ffffff",
};

const LED_COUNT = 16;
/** Window (s) shown by the mini input trace. */
const INPUT_WINDOW = 5;

function DashCluster({ theme, config, caps, size }: BaseWidgetProps<DashClusterConfig>) {
  const store = useStoreInstance();
  const t = theme.colors;
  const mono = theme.font.mono;

  const gearRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef<HTMLSpanElement | null>(null);
  const steerWrap = useRef<HTMLDivElement | null>(null);
  const steerVal = useRef<HTMLDivElement | null>(null);
  const ledRefs = useRef<(HTMLDivElement | null)[]>([]);
  const inputCanvas = useRef<HTMLCanvasElement | null>(null);

  const units = useSettings().units;
  // Fast-path widget — subscribe narrowly to just the car name (see useCarName)
  // instead of useSlow(), which would re-render on every slow-path tick.
  const carName = useCarName();
  // Per-car rev-light profile (LED count / thresholds / colors), if the live car
  // is recognized and the feature is on. Re-resolved only when the car changes.
  const profile = useMemo(
    () => (config.useCarData ? resolveCarLeds(carName) : null),
    [carName, config.useCarData]
  );
  const ledCount = config.showLeds && profile ? profile.ledCount : LED_COUNT;

  const live = useRef({ config, units, profile, ledCount });
  live.current = { config, units, profile, ledCount };

  // Cache the input-trace canvas's CSS size via ResizeObserver instead of
  // calling getBoundingClientRect() every animation frame (that forces a layout
  // read at 60fps). Re-observes when the canvas mounts/unmounts with showInputs.
  const inputSize = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const ic = inputCanvas.current;
    if (!ic) return;
    const measure = () => {
      const r = ic.getBoundingClientRect();
      inputSize.current = { w: r.width, h: r.height };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ic);
    return () => ro.disconnect();
  }, [config.showInputs]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { config, units, profile, ledCount } = live.current;
      const s = store.latestFast;
      if (s) {
        const gear = s.gear == null ? "N" : s.gear < 0 ? "R" : s.gear === 0 ? "N" : String(s.gear);
        setText(gearRef.current, gear);

        const sv = speedValue(s.speedMs, units);
        if (speedRef.current) setText(speedRef.current, sv == null ? "--" : String(Math.round(sv)));

        const rpm = s.rpm ?? 0;

        if (profile) {
          // Real per-car shift lights: each LED has its own RPM threshold (by
          // gear), its own color, and the whole strip flashes at the redline.
          const g = gearLeds(profile, s.gear);
          const redline = g?.redline ?? config.redlineRpm;
          const blinkMs = profile.blinkIntervalMs || 250;
          const flash = rpm >= redline && Math.floor(performance.now() / blinkMs) % 2 === 0;
          for (let i = 0; i < ledCount; i++) {
            const el = ledRefs.current[i];
            if (!el) continue;
            // Physical gap segments ("#000000" in the community data) are
            // stripped from the profile at load time (see carLeds.ts), so
            // every LED here is real and participates in sweep + flash.
            const col = profile.colors[i] ?? t.accent;
            const on = g ? rpm >= g.leds[i] : false;
            if (flash) {
              el.style.background = "#cfe8ff";
              el.style.boxShadow = "0 0 9px #cfe8ff";
            } else {
              el.style.background = on ? col : "rgba(255,255,255,0.08)";
              el.style.boxShadow = on ? `0 0 7px ${col}` : "none";
            }
          }
        } else {
          // Fallback: flat redline, evenly-spaced LEDs, fixed color bands.
          const rpmPct = Math.max(0, Math.min(1, rpm / config.redlineRpm));
          const flash = rpmPct > 0.97 && Math.floor(performance.now() / 70) % 2 === 0;
          for (let i = 0; i < ledCount; i++) {
            const el = ledRefs.current[i];
            if (!el) continue;
            const on = (i + 0.5) / ledCount <= rpmPct;
            const col = i < 6 ? t.throttle : i < 11 ? t.loss : t.accent;
            if (flash) {
              el.style.background = "#cfe8ff";
              el.style.boxShadow = "0 0 9px #cfe8ff";
            } else {
              el.style.background = on ? col : "rgba(255,255,255,0.08)";
              el.style.boxShadow = on ? `0 0 7px ${col}` : "none";
            }
          }
        }

        if (steerWrap.current) {
          const deg = s.steeringRad == null ? 0 : (s.steeringRad * 180) / Math.PI;
          // steeringRad is positive = left, so rotate the wheel anticlockwise.
          steerWrap.current.style.transform = `rotate(${-deg}deg)`;
          if (steerVal.current) setText(steerVal.current, s.steeringRad == null ? "--" : `${Math.round(Math.abs(deg))}°`);
        }
      }

      // Mini throttle/brake trace (only mounted when enabled). Size comes from
      // the ResizeObserver-cached value above, not a per-frame layout read.
      const ic = inputCanvas.current;
      if (ic) {
        const ctx = ic.getContext("2d");
        const { w: rw, h: rh } = inputSize.current;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = Math.max(1, Math.round(rw * dpr));
        const H = Math.max(1, Math.round(rh * dpr));
        if (ic.width !== W || ic.height !== H) {
          ic.width = W;
          ic.height = H;
        }
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawTrace(ctx, rw, rh, store.history, store.latestFast, t.throttle, t.brake);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [t.throttle, t.loss, t.accent, t.brake]);

  const showSteering = config.showSteering && (caps?.steeringAngle ?? true);
  // The wheel + angle label are one centered flex column whose natural height
  // (wheel + gap + label) is fixed in em, independent of the widget's box
  // size. At small heights that column is taller than the row it centers in,
  // so it overflows evenly above/below — pushing the label down into (and
  // past) the bottom padding while the gear/speed side still has slack.
  // Shrink the wheel a bit once height gets tight so the label clears the
  // panel edge instead of crowding it.
  const compactWheel = size.h < 135;
  const wheelEm = compactWheel ? "4.4em" : "5.4em";
  const wheelLabelGap = compactWheel ? 3 : 6;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "12px 16px 14px", boxSizing: "border-box", overflow: "hidden" }}>
      {config.showLeds && (
        // keyed on ledCount so the row fully remounts (and `ledRefs` resets) when
        // the recognized car's LED count differs from the fallback strip.
        <div key={ledCount} style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          {Array.from({ length: ledCount }, (_, i) => (
            <div
              key={i}
              ref={(el) => (ledRefs.current[i] = el)}
              style={{ flex: 1, height: 8, borderRadius: 3, background: "rgba(255,255,255,0.08)" }}
            />
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", gap: 12 }}>
        {/* Gear — a rounded SQUARE cell (matching the Input graph's gear cell):
            it fills the row height and its width tracks that height via the 1:1
            aspect ratio, so it reads as a square tile rather than a tall pill. */}
        <div style={{ flex: "0 0 auto", alignSelf: "center", height: "84%", aspectRatio: "1 / 1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: t.cell, borderRadius: 16, boxSizing: "border-box", overflow: "hidden" }}>
          <div ref={gearRef} style={{ fontFamily: theme.font.family, fontWeight: 700, fontSize: "4em", lineHeight: 0.82, color: config.gearColor ?? "#ffffff" }}>N</div>
          <div style={{ fontFamily: theme.font.label, fontSize: "0.6em", fontWeight: 600, letterSpacing: "0.22em", color: t.textDim, marginTop: 3 }}>GEAR</div>
        </div>

        {/* Center: big speed, plus an optional mini input trace below it */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span ref={speedRef} style={{ fontFamily: theme.font.family, fontWeight: 700, fontSize: "3.6em", lineHeight: 0.85, color: "#fff", fontVariantNumeric: "tabular-nums" }}>0</span>
            <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "0.9em", letterSpacing: "0.1em", color: t.textDim }}>{speedLabel(units)}</span>
          </div>
          {config.showInputs && (
            <div style={{ width: "100%", flex: 1, minHeight: "2.2em", position: "relative", background: "rgba(255,255,255,0.04)", borderRadius: 8, overflow: "hidden" }}>
              <canvas ref={inputCanvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
            </div>
          )}
        </div>

        {/* Steering wheel — vertically centered in the (stretched) row */}
        {showSteering && (
          <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ flex: "0 0 auto", width: wheelEm, height: wheelEm, borderRadius: "50%", border: "3px solid rgba(255,255,255,0.22)", position: "relative", boxSizing: "border-box" }}>
              <div ref={steerWrap} style={{ position: "absolute", inset: 0 }}>
                <div style={{ position: "absolute", top: "50%", left: 7, right: 7, height: 3, background: t.accent, transform: "translateY(-50%)", borderRadius: 2, boxShadow: `0 0 8px ${t.accent}` }} />
                <div style={{ position: "absolute", top: "50%", left: "50%", width: 11, height: 11, background: t.accent, borderRadius: "50%", transform: "translate(-50%,-50%)" }} />
                <div style={{ position: "absolute", top: 5, left: "50%", width: 3, height: 11, background: "rgba(255,255,255,0.5)", transform: "translateX(-50%)", borderRadius: 2 }} />
              </div>
            </div>
            <div ref={steerVal} style={{ fontFamily: mono, fontWeight: 600, fontSize: "0.72em", color: t.textDim, marginTop: wheelLabelGap }}>0°</div>
          </div>
        )}
      </div>
    </div>
  );
}

export const dashClusterDef: WidgetDefinition<DashClusterConfig> = {
  id: "dash-cluster",
  name: "Dash Cluster",
  defaultSize: { w: 470, h: 150 },
  minSize: { w: 300, h: 116 },
  defaultConfig,
  // Reads store.latestFast/history at 60fps (fast) plus the live car's name
  // (slow, via useCarName) to resolve its shift-light profile.
  requiredPaths: ["fast", "slow"],
  requiredCapabilities: [],
  configSchema: [
    { key: "useCarData", label: "Use car shift-light data", type: "boolean" },
    { key: "redlineRpm", label: "Redline (fallback)", type: "number", min: 4000, max: 15000, step: 100 },
    { key: "showLeds", label: "Shift lights", type: "boolean" },
    { key: "showInputs", label: "Input graph", type: "boolean" },
    { key: "showSteering", label: "Steering", type: "boolean" },
    { key: "gearColor", label: "Gear color", type: "color", presets: GEAR_COLOR_PRESETS },
  ],
  Component: DashCluster,
};

function setText(el: HTMLElement | null, s: string) {
  if (el && el.textContent !== s) el.textContent = s;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** "#rrggbb" + alpha → rgba() for canvas fills. */
function withAlpha(color: string, a: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return color;
}

/** Filled throttle/brake area traces over the recent window. */
function drawTrace(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  history: { ts: number; throttle: number | null; brake: number | null }[],
  latest: { ts: number } | null,
  throttleColor: string,
  brakeColor: string
) {
  ctx.clearRect(0, 0, w, h);
  if (!latest || history.length < 2) return;
  const tNow = latest.ts;
  const xOf = (ts: number) => w * (1 - (tNow - ts) / INPUT_WINDOW);
  const top = 2;
  const bottom = h - 2;
  const ph = Math.max(1, bottom - top);

  const area = (key: "throttle" | "brake", fill: string, stroke: string) => {
    let started = false;
    ctx.beginPath();
    for (const s of history) {
      const v = s[key];
      if (v == null) continue;
      const x = xOf(s.ts);
      const y = bottom - clamp01(v) * ph;
      if (!started) {
        ctx.moveTo(x, bottom);
        ctx.lineTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    if (!started) return;
    ctx.lineTo(w, bottom);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    started = false;
    for (const s of history) {
      const v = s[key];
      if (v == null) continue;
      const x = xOf(s.ts);
      const y = bottom - clamp01(v) * ph;
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  };

  area("throttle", withAlpha(throttleColor, 0.18), throttleColor);
  area("brake", withAlpha(brakeColor, 0.16), brakeColor);
}
