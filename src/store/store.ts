// The snapshot store. Enforces the fast/slow split (perf non-negotiable #2):
//
// - FAST path (pedals/steering/rpm, ~60 Hz) is NOT exposed through React state.
//   Re-rendering React at 60 Hz would be the exact stutter we're avoiding.
//   Instead the latest sample + a history ring live in plain fields, and the
//   Input graph reads them directly inside its own requestAnimationFrame loop.
//
// - SLOW path (session/laps/deltas, a few Hz) IS exposed via subscribe/get, so
//   text widgets can use `useSyncExternalStore` and re-render only on change.

import type { Capabilities, FastSample, SlowSample } from "./types";

/** ~8 seconds of history at 60 Hz — enough for the scrolling input trace. */
const MAX_HISTORY = 540;

/** Window for measuring the push (event) rate, ms. */
const RATE_WINDOW_MS = 1000;

type Listener = () => void;

/** Largest plausible finishing position; anything beyond is a sentinel, not a place. */
const MAX_SANE_POSITION = 1000;

/**
 * iRacing reports "no position" as `-1`, which arrives over the `u32` wire as
 * `4294967295` (u32::MAX). Older replay captures baked that value in, so normalize
 * any out-of-range position to `null` — doing it here at the single slow-ingest
 * choke point fixes every widget at once (Standings, Relative, …).
 */
function sanePos(n: number | null): number | null {
  return n == null || n <= 0 || n > MAX_SANE_POSITION ? null : n;
}

/**
 * iRacing's `SessionLapsRemainEx` returns 32767 for a timed/unlimited session and
 * `SessionTimeRemain` returns -1 (or ~a week) — sentinels, not real values. The
 * connector now maps these to null, but captures recorded before that fix have
 * the raw sentinels baked in, so normalize on replay too.
 */
const LAPS_SENTINEL = 32767;
const TIME_SENTINEL_MAX = 604800; // one week (s) — unlimited sessions report this

function sanitizeSlow(s: SlowSample): void {
  s.position = sanePos(s.position);
  s.classPosition = sanePos(s.classPosition);
  for (const c of s.cars) {
    c.position = sanePos(c.position);
    c.classPosition = sanePos(c.classPosition);
  }
  if (s.lapsRemaining != null && (s.lapsRemaining < 0 || s.lapsRemaining >= LAPS_SENTINEL)) {
    s.lapsRemaining = null;
  }
  if (s.timeRemainingS != null && (s.timeRemainingS < 0 || s.timeRemainingS >= TIME_SENTINEL_MAX)) {
    s.timeRemainingS = null;
  }
}

export class TelemetryStore {
  // --- fast path (read directly, not via React) ---
  latestFast: FastSample | null = null;
  history: FastSample[] = [];

  /** Render rate reported by the Input graph's rAF loop, for the perf HUD. */
  graphFps = 0;

  private pushTimes: number[] = [];

  // --- slow path (React-subscribable) ---
  private slow: SlowSample | null = null;
  private caps: Capabilities | null = null;
  private slowListeners = new Set<Listener>();

  ingestFast(sample: FastSample) {
    this.latestFast = sample;
    this.history.push(sample);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    const now = performance.now();
    this.pushTimes.push(now);
    // Prune outside the measurement window.
    const cutoff = now - RATE_WINDOW_MS;
    while (this.pushTimes.length && this.pushTimes[0] < cutoff) {
      this.pushTimes.shift();
    }
  }

  /** Measured event push rate (Hz) over the last second. */
  pushHz(): number {
    const now = performance.now();
    const cutoff = now - RATE_WINDOW_MS;
    let i = 0;
    while (i < this.pushTimes.length && this.pushTimes[i] < cutoff) i++;
    return this.pushTimes.length - i;
  }

  ingestSlow(sample: SlowSample) {
    sanitizeSlow(sample);
    this.slow = sample;
    this.slowListeners.forEach((l) => l());
  }

  setCaps(caps: Capabilities) {
    this.caps = caps;
    this.slowListeners.forEach((l) => l());
  }

  // useSyncExternalStore contract for the slow path.
  subscribeSlow = (listener: Listener): (() => void) => {
    this.slowListeners.add(listener);
    return () => this.slowListeners.delete(listener);
  };
  getSlow = (): SlowSample | null => this.slow;
  getCaps = (): Capabilities | null => this.caps;
}

export const store = new TelemetryStore();
