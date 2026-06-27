import { useRef } from "react";
import { useSlow } from "../store/hooks";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface SlowCarAheadConfig {
  distanceThresholdM: number;
  barThickness: number;
}

const defaultConfig: SlowCarAheadConfig = {
  distanceThresholdM: 200,
  barThickness: 8,
};

/**
 * How long (ms) since the last observed motion before a car is considered
 * "stopped". Using a sustained window prevents a single no-op render
 * (duplicate telemetry tick, React StrictMode double-invoke, etc.) from
 * incorrectly latching the "stopped" state.
 */
const MOTION_WINDOW_MS = 700;

/** ΔlapDistPct per ms below which we do NOT count as motion. */
const MOTION_EPSILON_PCT_PER_MS = 0.0001 / 100; // ≈ 0.00000 1 pct/ms

interface CarSample {
  pct: number;
  /** performance.now() when pct was recorded */
  t: number;
  /** performance.now() of the last render in which forward motion was detected */
  lastMotionT: number;
}

function SlowCarAhead({ theme, config }: BaseWidgetProps<SlowCarAheadConfig>) {
  const t = theme.colors;
  const slow = useSlow();
  const playerIdx = slow?.playerCarIdx ?? null;

  // Keyed by carIdx. Persists across renders via ref (never triggers re-render).
  const samples = useRef<Map<number, CarSample>>(new Map());

  let nearest: { gap: number; onPitRoad: boolean; moving: boolean; name: string } | null = null;

  const now = performance.now();
  const seenIdxs = new Set<number>();

  for (const c of slow?.cars ?? []) {
    if (c.isPlayer || c.carIdx === playerIdx) continue;
    // Skip garaged cars (not in world): real iRacing reports lapDistPct === -1
    // for these, so without this guard a stationary garaged car could be picked
    // as the "nearest, stopped" car ahead.
    if (c.inWorld === false || c.lapDistPct == null || c.lapDistPct < 0) continue;
    const gap = c.gapToPlayerS;
    if (gap == null || gap <= 0) continue;

    const distM = gap * 42;
    if (distM > config.distanceThresholdM) continue;

    seenIdxs.add(c.carIdx);

    const curPct = c.lapDistPct ?? 0;
    const prev = samples.current.get(c.carIdx);

    let lastMotionT: number;

    if (prev == null) {
      // First time we see this car — assume moving until we have evidence otherwise.
      lastMotionT = now;
    } else {
      const dt = now - prev.t;
      if (dt > 0) {
        // Handle lap wrap: 0.99 → 0.01 is forward motion (~0.02 pct), not a
        // backwards jump of 0.98. Always take the smaller absolute delta.
        let dPct = curPct - prev.pct;
        if (dPct < -0.5) dPct += 1.0; // wrapped forward past start/finish
        if (dPct > 0.5) dPct -= 1.0;  // would be huge backward jump — clamp

        const velocity = dPct / dt; // pct per ms (positive = forward)
        if (velocity > MOTION_EPSILON_PCT_PER_MS) {
          lastMotionT = now;
        } else {
          // No meaningful forward motion this render; preserve the previous
          // lastMotionT so the window can expire naturally.
          lastMotionT = prev.lastMotionT;
        }
      } else {
        // dt == 0 (same timestamp) — treat as no new information.
        lastMotionT = prev.lastMotionT;
      }
    }

    samples.current.set(c.carIdx, { pct: curPct, t: now, lastMotionT });

    // Moving = had forward motion within the last MOTION_WINDOW_MS.
    const moving = now - lastMotionT < MOTION_WINDOW_MS;

    if (nearest == null || gap < nearest.gap) {
      nearest = {
        gap,
        onPitRoad: c.onPitRoad ?? false,
        moving,
        name: c.driverName ?? c.carNumber ?? `#${c.carIdx}`,
      };
    }
  }

  // Purge stale entries so the Map doesn't grow across session resets or when
  // cars drop off track. Only keep cars that were candidates this tick.
  for (const key of samples.current.keys()) {
    if (!seenIdxs.has(key)) {
      samples.current.delete(key);
    }
  }

  if (!nearest) {
    return (
      <div style={{ fontFamily: theme.font.label, width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: t.textDim2, fontWeight: 600, fontSize: "0.7em", letterSpacing: "0.1em" }}>
        NO SLOW CARS AHEAD
      </div>
    );
  }

  const distM = nearest.gap * 42;
  const frac = Math.max(0, Math.min(1, 1 - distM / config.distanceThresholdM));
  const color = nearest.onPitRoad ? t.gain : nearest.moving ? t.amber : t.loss;

  // Bar thickness is configured in px but rendered in em (÷14 ≈ base font) so it
  // scales with the widget's effective font scale instead of staying fixed.
  const barEm = config.barThickness / 14;

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: "0.5em", padding: "0 1.1em", boxSizing: "border-box", color: t.text }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.5em" }}>
        <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.6em", letterSpacing: "0.12em", color: t.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>SLOW CAR AHEAD</span>
        <span style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "1.4em", color, flexShrink: 0 }}>{Math.round(distM)}<span style={{ fontSize: "0.5em", color: t.textDim }}>m</span></span>
      </div>
      <div style={{ height: `${barEm}em`, borderRadius: `${barEm / 2}em`, background: "rgba(255,255,255,0.07)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${frac * 100}%`, background: color, borderRadius: `${barEm / 2}em`, transition: "width 0.15s linear" }} />
      </div>
      <div style={{ fontWeight: 500, fontSize: "0.72em", color: nearest.onPitRoad ? t.textDim : color, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {nearest.onPitRoad ? "off-track" : nearest.moving ? "on-track" : "stopped"} · {nearest.name}
      </div>
    </div>
  );
}

export const slowCarAheadDef: WidgetDefinition<SlowCarAheadConfig> = {
  id: "slow-car-ahead",
  name: "Slow Car Ahead",
  defaultSize: { w: 280, h: 100 },
  minSize: { w: 200, h: 70 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [
    { key: "distanceThresholdM", label: "Range (m)", type: "number", min: 50, max: 500, step: 10 },
    { key: "barThickness", label: "Bar (px)", type: "number", min: 4, max: 20, step: 1 },
  ],
  Component: SlowCarAhead,
};
