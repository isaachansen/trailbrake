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
