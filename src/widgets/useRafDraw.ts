// Shared throttled-rAF driver for fast-path widgets (see CLAUDE.md's fast/slow
// split + InputGraph.tsx, the reference imperative widget). Replaces the
// ad-hoc `let raf = 0; const draw = () => {...}; raf = requestAnimationFrame(draw);`
// loops that used to live inline in each widget's `useEffect`.
//
// Contract (mirrors InputGraph's imperative ref-poking pattern): `draw` reads
// telemetry directly off `store.latestFast` / `store.history` / `store.getSlow()`
// (via whatever closure/refs the caller sets up) and repaints a canvas and/or
// pokes DOM nodes through refs. It must NEVER call a React state setter — fast
// data never goes through React state (see CLAUDE.md, InputGraph.tsx).
//
// One `useRafDraw` call owns exactly one requestAnimationFrame loop:
//  - Every native rAF tick, the elapsed time since the last time `draw` actually
//    ran is compared against `1000 / fps` (when `fps` is given); `draw` only
//    fires once that interval has elapsed, so a widget capped to e.g. 24fps
//    repaints far less often than the display's refresh rate.
//  - `draw` receives `(nowMs, dtMs)`: `nowMs` is the rAF timestamp, `dtMs` is the
//    real elapsed time since the PREVIOUS call to `draw` (not the previous raw
//    rAF tick) — use it for frame-rate-independent easing (e.g.
//    `1 - Math.exp(-dtMs / 1000 / tau)`), same idea as TrackMap's existing dt-based
//    smoothing. The very first call gets `dtMs = 0`.
//  - When `fps` is omitted, `draw` runs on every rAF tick (i.e. at the display's
//    native refresh rate) — the same behavior as the old unthrottled loops.
//  - While `document.hidden` (the overlay window isn't the visible/foreground
//    surface — e.g. no active session, window occluded/minimized), the loop is
//    fully cancelled rather than merely skipping draws: zero rAF callbacks fire
//    at all. It resumes automatically on the next `visibilitychange` where
//    `document.hidden` is false.
//  - A `draw` that throws is caught and logged (`console.error`) so one broken
//    widget can never wedge every other widget's animation loop.
//  - `deps` has the same semantics as `useEffect`'s dependency array: passing a
//    stable value/`[]` keeps one loop alive for the component's lifetime; a
//    changing entry tears down and restarts the loop (fresh `dtMs`/timing state).
//    Note the `draw` callback itself is always read fresh via a ref on every
//    render, independent of `deps` — a new `draw` closure (e.g. one that closes
//    over updated `theme`/`config`) takes effect on the very next tick without
//    needing to be listed in `deps`.
//
// Dirty-skip (`opts.shouldDraw`): an optional predicate checked once the fps
// gate above has already elapsed, immediately before `draw` would otherwise be
// called. Returning `false` skips this frame's `draw()` call entirely (no
// canvas/DOM work) WITHOUT advancing the "last drawn at" clock, so `dtMs` on
// the next frame that actually draws still reflects the real elapsed time
// since the last real paint — easing stays frame-rate-independent across a run
// of skipped frames exactly as it would across a run of throttled ones.
// `shouldDraw` is read fresh every render via a ref, same as `draw`. Omit it to
// draw unconditionally (the pre-dirty-skip behavior). Correctness contract:
// widgets must never end up visibly stuck — a `shouldDraw` should return
// `true` on the very first call (compare against an `undefined`-initialized
// ref, since real telemetry values are always `null` or an object, never
// `undefined`) and whenever ANY input the draw depends on (telemetry
// reference, config, canvas size) has changed since the last real paint.
//
// Cleans up the rAF loop and the visibility listener on unmount / dep change.
//
// `opts.enabled` (default true): when false, the loop is not running — no rAF
// callbacks fire at all, same "fully stopped" contract as the `document.hidden`
// handling above. For a widget that self-hides (renders nothing) when it has
// nothing to show — e.g. Radar with no neighbour in range — so it doesn't spin
// an idle 60fps no-op loop while invisible. Read fresh every render via a ref
// (like `fps`/`shouldDraw`) and reacted to via a small dedicated effect that
// starts/stops the SAME loop instance rather than tearing down and rebuilding
// the whole effect — that keeps `dtMs` timing/easing state intact across a
// hide/show instead of resetting it like a `deps` change would.

import { useEffect, useRef } from "react";

export interface UseRafDrawOptions {
  /** Max draw() calls per second. Omit to run at the display's native refresh rate. */
  fps?: number;
  /**
   * Dirty-skip predicate: return `false` to skip this frame's `draw()` call
   * entirely (checked after the fps gate). Omit to always draw. See the
   * module doc comment above for the correctness contract.
   */
  shouldDraw?: () => boolean;
  /**
   * When false, the loop doesn't run at all (see the module doc comment).
   * Defaults to true — existing callers are unaffected.
   */
  enabled?: boolean;
}

export function useRafDraw(
  draw: (nowMs: number, dtMs: number) => void,
  opts: UseRafDrawOptions,
  deps: unknown[]
): void {
  // Always call the latest `draw`/`shouldDraw` — this is what lets callers
  // close over fresh theme/config every render without needing to list them
  // in `deps`.
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const fpsRef = useRef(opts.fps);
  fpsRef.current = opts.fps;
  const shouldDrawRef = useRef(opts.shouldDraw);
  shouldDrawRef.current = opts.shouldDraw;
  const enabledRef = useRef(opts.enabled ?? true);
  enabledRef.current = opts.enabled ?? true;

  // Exposes the running loop's own start/stop so the dedicated `enabled`
  // effect below can pause/resume the SAME loop instance without re-running
  // the main effect (which would reset `lastCall`/dtMs timing).
  const controlRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  useEffect(() => {
    let raf = 0;
    let lastCall = 0; // performance.now() of the last time draw() actually ran

    const tick = (now: number) => {
      const fps = fpsRef.current;
      const minInterval = fps && fps > 0 ? 1000 / fps : 0;
      if (now - lastCall >= minInterval) {
        const gate = shouldDrawRef.current;
        if (!gate || gate()) {
          const dt = lastCall === 0 ? 0 : now - lastCall;
          lastCall = now;
          try {
            drawRef.current(now, dt);
          } catch (err) {
            console.error("useRafDraw: draw() threw", err);
          }
        }
        // else: dirty-skip — leave `lastCall` untouched so the next real
        // paint's `dtMs` still reflects true elapsed time since the last one.
      }
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (raf) return;
      if (!enabledRef.current) return; // stay stopped while disabled
      // Reset timing so resuming from hidden doesn't feed a huge dtMs from the
      // time spent paused into the next easing step.
      lastCall = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    controlRef.current = { start, stop };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
      controlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // React to `enabled` toggling on its own, independent of `deps` — pauses/
  // resumes the existing loop instance (via `controlRef`) instead of tearing
  // down and recreating the whole effect above.
  useEffect(() => {
    const enabled = opts.enabled ?? true;
    if (enabled) controlRef.current?.start();
    else controlRef.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled]);
}
