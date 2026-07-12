import { useRef, useSyncExternalStore } from "react";
import { useSlow } from "../store/hooks";
import { useStoreInstance } from "../store/storeContext";
import { useScreenLayer } from "../components/screenLayer";
import { editModeStore } from "../store/editMode";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface SlowCarAheadConfig {
  /** Maximum distance ahead (m) to warn about a slow car. */
  maxDistanceM: number;
  /** Derived opponent speed (m/s) below which they count as a slow-car hazard (~50 km/h). */
  slowSpeedThresholdMs: number;
  /** Derived opponent speed (m/s) at or below which they count as stopped (~5 km/h). */
  stoppedSpeedThresholdMs: number;
  barThickness: number;
}

const defaultConfig: SlowCarAheadConfig = {
  maxDistanceM: 250,
  slowSpeedThresholdMs: 13.9, // ~50 km/h — matches irDashies default
  stoppedSpeedThresholdMs: 1.4, // ~5 km/h — matches irDashies default
  barThickness: 8,
};

const SPEED_AVG_WINDOW = 5;

interface SpeedEntry {
  prevPct: number;
  /** performance.now() at prevPct capture (ms). SessionTime is not on SlowSample,
   *  so wall-clock is used. Accuracy degrades if the process is throttled between ticks. */
  prevNowMs: number;
  /** Moving-average history in m/s, up to SPEED_AVG_WINDOW samples. */
  history: number[];
}

function SlowCarAhead({ theme, config }: BaseWidgetProps<SlowCarAheadConfig>) {
  const t = theme.colors;
  const slow = useSlow();
  const store = useStoreInstance();
  const editing = useSyncExternalStore(editModeStore.subscribe, editModeStore.get);
  const { preview } = useScreenLayer();

  // Speed estimates derived from ΔlapDistPct × trackLength / Δwall-clock-time (5-sample MA).
  const speedBuffer = useRef<Map<number, SpeedEntry>>(new Map());

  const trackLen = slow?.trackLengthM ?? null;
  const playerIdx = slow?.playerCarIdx ?? null;
  const playerSpeedMs = store.latestFast?.speedMs ?? null;

  const maxDist = config.maxDistanceM ?? defaultConfig.maxDistanceM;
  const slowThreshMs = config.slowSpeedThresholdMs ?? defaultConfig.slowSpeedThresholdMs;
  const stoppedThreshMs = config.stoppedSpeedThresholdMs ?? defaultConfig.stoppedSpeedThresholdMs;

  const nowMs = performance.now();
  const seenIdxs = new Set<number>();

  let nearest: { distanceM: number; name: string; isStopped: boolean } | null = null;

  // trackLengthM is required — without it we cannot derive speeds or distances.
  const hasTrack = trackLen != null && trackLen > 100;

  if (hasTrack && playerIdx != null && playerSpeedMs != null) {
    const playerCar = slow!.cars.find((c) => c.carIdx === playerIdx);
    const playerPct = playerCar?.lapDistPct ?? null;

    for (const c of slow!.cars) {
      if (c.carIdx === playerIdx) continue;
      if (c.inWorld === false) continue;
      if (c.lapDistPct == null || c.lapDistPct < 0) continue;
      if (c.onPitRoad === true) continue;

      seenIdxs.add(c.carIdx);

      // Derive speed from ΔlapDistPct × trackLength / Δt (moving average)
      const entry = speedBuffer.current.get(c.carIdx);
      let avgSpeedMs = 0;

      if (entry != null) {
        const dtMs = nowMs - entry.prevNowMs;
        if (dtMs >= 50) {
          let dPct = c.lapDistPct - entry.prevPct;
          if (dPct < -0.5) dPct += 1.0; // lap crossover
          // Backwards movement (off-track, incident) treated as 0 for this sample
          const sample = dPct >= 0 ? (dPct * trackLen) / (dtMs / 1000) : 0;
          const next = [...entry.history, sample].slice(-SPEED_AVG_WINDOW);
          speedBuffer.current.set(c.carIdx, { prevPct: c.lapDistPct, prevNowMs: nowMs, history: next });
          avgSpeedMs = next.reduce((a, b) => a + b, 0) / next.length;
        } else {
          // Not enough time elapsed — use last-known average
          avgSpeedMs =
            entry.history.length > 0 ? entry.history.reduce((a, b) => a + b, 0) / entry.history.length : 0;
        }
      } else {
        // First sample seen for this car — record baseline, no speed estimate yet
        speedBuffer.current.set(c.carIdx, { prevPct: c.lapDistPct, prevNowMs: nowMs, history: [] });
        continue;
      }

      // Gate 1: opponent must be below slow threshold
      if (avgSpeedMs > slowThreshMs) continue;

      // Gate 2: opponent must be slower than player by at least slowThreshMs margin
      // (irDashies: speed + threshold > playerSpeed → skip)
      if (avgSpeedMs + slowThreshMs > playerSpeedMs) continue;

      // Gate 3: opponent must be ahead of player (positive wrapped distance)
      if (playerPct == null) continue;
      let relPct = c.lapDistPct - playerPct;
      if (relPct > 0.5) relPct -= 1.0;
      else if (relPct < -0.5) relPct += 1.0;
      const distM = relPct * trackLen;
      if (distM <= 0) continue;

      // Gate 4: must be within maxDistanceM
      if (distM > maxDist) continue;

      if (nearest == null || distM < nearest.distanceM) {
        nearest = {
          distanceM: distM,
          name: c.driverName ?? c.carNumber ?? `#${c.carIdx}`,
          isStopped: avgSpeedMs <= stoppedThreshMs,
        };
      }
    }
  }

  // Evict cars that are no longer in the session
  for (const key of speedBuffer.current.keys()) {
    if (!seenIdxs.has(key)) speedBuffer.current.delete(key);
  }

  const forceShow = editing || preview;
  if (!nearest && !forceShow) return null;

  const selfPanel = !editing && !preview;
  const frac = nearest ? Math.max(0, Math.min(1, 1 - nearest.distanceM / maxDist)) : 0.6;
  const color = t.loss;
  const barEm = config.barThickness / 14;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: "0.5em",
        padding: theme.widgetPad,
        boxSizing: "border-box",
        color: t.text,
        ...(selfPanel
          ? {
              background: t.surface,
              border: `1px solid ${t.surfaceBorder}`,
              borderRadius: theme.radius,
              backdropFilter: theme.panelBlur,
              WebkitBackdropFilter: theme.panelBlur,
              boxShadow: theme.panelShadow,
            }
          : null),
      }}
    >
      {nearest ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "flex-end",
              gap: "0.5em",
            }}
          >
            <span
              style={{
                fontFamily: theme.font.mono,
                fontWeight: 700,
                fontSize: "1.4em",
                color,
                flexShrink: 0,
              }}
            >
              {Math.round(nearest.distanceM)}
              <span style={{ fontSize: "0.5em", color: t.textDim }}>m</span>
            </span>
          </div>
          <div
            style={{
              height: `${barEm}em`,
              borderRadius: `${barEm / 2}em`,
              background: "rgba(255,255,255,0.07)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${frac * 100}%`,
                background: color,
                borderRadius: `${barEm / 2}em`,
                transition: "width 0.15s linear",
              }}
            />
          </div>
          <div
            style={{
              fontWeight: 500,
              fontSize: "0.72em",
              color,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {nearest.isStopped ? "STOPPED" : "SLOW"} · {nearest.name}
          </div>
        </>
      ) : (
        <div
          style={{
            fontFamily: theme.font.label,
            textAlign: "center",
            color: t.textDim2,
            fontWeight: 600,
            fontSize: "0.7em",
            letterSpacing: "0.1em",
          }}
        >
          CLEAR
        </div>
      )}
    </div>
  );
}

export const slowCarAheadDef: WidgetDefinition<SlowCarAheadConfig> = {
  id: "slow-car-ahead",
  name: "Slow Car Ahead",
  defaultSize: { w: 280, h: 100 },
  minSize: { w: 200, h: 70 },
  defaultConfig,
  requiredPaths: ["slow", "fast"],
  requiredCapabilities: [],
  configSchema: [
    { key: "maxDistanceM", label: "Range (m)", type: "number", min: 50, max: 500, step: 10 },
    {
      key: "slowSpeedThresholdMs",
      label: "Slow below (m/s)",
      type: "number",
      min: 3,
      max: 30,
      step: 0.5,
    },
    {
      key: "stoppedSpeedThresholdMs",
      label: "Stopped below (m/s)",
      type: "number",
      min: 0.5,
      max: 5,
      step: 0.5,
    },
    { key: "barThickness", label: "Bar (px)", type: "number", min: 4, max: 20, step: 1 },
  ],
  transparentPanel: () => true,
  Component: SlowCarAhead,
};
