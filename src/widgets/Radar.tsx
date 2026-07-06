// Radar: a spotter's-eye proximity view of cars right next to you. Each car is
// placed by its lateral / longitudinal offset (meters) relative to the player;
// the player sits fixed at center. A neighbour only warns when it is BOTH
// longitudinally alongside AND laterally door-to-door (never on lon distance
// alone — a car across the track or on a parallel line must not light up).
// Genuinely alongside cars turn amber ("caution") and light the corresponding
// screen edge; laterally very close ones escalate to red ("contact imminent").
//
// The data (relLatM/relLonM) is slow-path, but rendering runs on a rAF loop that
// eases the drawn positions toward the latest sample, so the blips glide instead
// of snapping at the 5 Hz update rate. Hidden unless the sim provides proximity.
//
// The widget also self-hides (like Flag.tsx) when no neighbour is actually in
// radar range — an empty radar is dead chrome, not information — and reappears
// the moment a car enters. See `hasNeighbour` below.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSlow } from "../store/hooks";
import { useScreenLayer } from "../components/screenLayer";
import { editModeStore } from "../store/editMode";
import { isLiveOverlayWindow } from "../store/windowKind";
import { hexToRgba } from "./format";
import { WidgetTitle } from "./WidgetTitle";
import { useRafDraw } from "./useRafDraw";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { SlowSample } from "../store/types";

export interface RadarConfig {
  /** Half-range shown above/below the player, in meters. */
  rangeM: number;
}

const defaultConfig: RadarConfig = { rangeM: 16 };

/**
 * How long (ms) to keep the radar visible after the last in-range neighbour
 * disappears before auto-hiding. Without this, a car sitting right at the
 * range boundary — or the slow path's ~5Hz update cadence — could make the
 * widget flicker in and out as a car crosses in/out of range from one sample
 * to the next; lingering a moment smooths that out.
 */
const LINGER_MS = 1200;

/** Longitudinal distance (m) within which a neighbour counts as "alongside". */
const ALONGSIDE_M = 3;

/** Outer lateral distance (m) a car may sit at and still read as genuinely
 *  door-to-door. Racing cars are ~2m wide, so two side-by-side centers land
 *  roughly 2-4m apart; wider than this is a different racing line (across
 *  the track, a parallel straight, an S-curve) and must NOT warn. */
const ALONGSIDE_LAT_M = 3.8;

/** Lateral distance (m) inside which an alongside car is close enough that
 *  contact is imminent — essentially touching doors. Below this: red. Between
 *  this and ALONGSIDE_LAT_M: yellow (alongside, but room to work with). */
const CONTACT_LAT_M = 2;

/** Warning severity for a screen edge / a given blip. */
type Tier = "none" | "caution" | "contact";
const TIER_RANK: Record<Tier, number> = { none: 0, caution: 1, contact: 2 };

interface Blip {
  lat: number;
  lon: number;
}

/** A neighbour only "counts" for a warning when it's both longitudinally
 *  alongside AND laterally within a real side-by-side band — longitudinal
 *  proximity alone (the old bug) fires for cars on the other side of the
 *  track or a parallel straight with no lateral gating at all. */
function tierOf(b: Blip): Tier {
  if (Math.abs(b.lon) >= ALONGSIDE_M || Math.abs(b.lat) >= ALONGSIDE_LAT_M) return "none";
  return Math.abs(b.lat) < CONTACT_LAT_M ? "contact" : "caution";
}

/**
 * Exponential-smoothing time constant (s) for blip positions. The widget used
 * to ease with a fixed per-frame fraction (`cur += (target-cur)*0.25`) at an
 * unthrottled ~60fps draw rate; now that the draw rate is capped (see the fps
 * option passed to `useRafDraw` below), the easing must be time- rather than
 * frame-based so it still glides at the same visual speed. Solving
 * `1 - exp(-dt/tau) = 0.25` for dt ≈ 16.7ms (60Hz) gives tau ≈ 0.058s, which
 * reproduces the old feel exactly at 60Hz and stays consistent at any fps.
 */
const POSITION_EASE_TAU_S = 0.058;

/**
 * Below this per-axis delta (meters), a blip's eased position is considered
 * "settled" for dirty-skip purposes — at the widget's typical pixel scale
 * (~5-10 px/m) this is a fraction of a pixel, so treating it as converged
 * never produces a visible stutter when the widget then goes quiet.
 */
const POSITION_EPSILON_M = 0.01;

/**
 * Whether at least one neighbour is actually in radar range right now — i.e.
 * would be drawn as a blip. Mirrors the draw loop's car filter (below) plus
 * its `abs(relLonM) <= range + 3` range cull precisely, so presence (used to
 * show/hide the whole widget) can never disagree with what would be painted:
 * the radar never shows empty, and never hides while a blip would be visible.
 */
function hasVisibleNeighbour(slow: SlowSample | null, rangeM: number): boolean {
  if (!slow) return false;
  const playerIdx = slow.playerCarIdx ?? null;
  for (const c of slow.cars ?? []) {
    if (c.isPlayer || c.carIdx === playerIdx) continue;
    if (c.relLatM == null || c.relLonM == null) continue;
    if (c.inWorld === false) continue;
    if (Math.abs(c.relLonM) > rangeM + 3) continue;
    return true;
  }
  return false;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

interface RadarGradients {
  leftLoss: CanvasGradient;
  leftAmber: CanvasGradient;
  rightLoss: CanvasGradient;
  rightAmber: CanvasGradient;
}

/**
 * The left/right warning-edge gradients, keyed only on canvas width and the
 * two possible warning colors (loss/amber) — there are just four combinations,
 * so they're built once per resize (see the setup effect) instead of being
 * allocated with `createLinearGradient` on every draw() call.
 */
function buildGradients(ctx: CanvasRenderingContext2D, w: number, lossColor: string, amberColor: string): RadarGradients {
  const build = (x0: number, x1: number, color: string) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, hexToRgba(color, 0.5));
    g.addColorStop(1, hexToRgba(color, 0));
    return g;
  };
  return {
    leftLoss: build(0, w * 0.42, lossColor),
    leftAmber: build(0, w * 0.42, amberColor),
    rightLoss: build(w, w * 0.58, lossColor),
    rightAmber: build(w, w * 0.58, amberColor),
  };
}

function Radar({ theme, config }: BaseWidgetProps<RadarConfig>) {
  const store = useStoreInstance();
  const t = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ config });
  live.current = { config };

  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const gradsRef = useRef<RadarGradients | null>(null);
  // Eased positions per car, keyed by carIdx — persists across draw() calls.
  const shownRef = useRef(new Map<number, Blip>());

  // Dirty-skip bookkeeping. `forceRef` starts `true` (first frame always
  // paints) and is re-armed by resize() so a widget resize/DPR change is never
  // skipped even without new telemetry. `maxDeltaRef` starts at `Infinity` so
  // the widget keeps drawing until the very first easing pass has actually run
  // (never "converged" before it's had a chance to move at all).
  const forceRef = useRef(true);
  const lastSlowRef = useRef<SlowSample | null | undefined>(undefined);
  const lastConfigRef = useRef<RadarConfig | undefined>(undefined);
  const maxDeltaRef = useRef(Infinity);

  // Auto-hide/show (like Flag.tsx's no-flag case): a React-side subscription so
  // the component actually re-renders when presence changes — the rAF draw
  // loop above/below keeps reading the store directly for the drawing itself,
  // this is purely for the show/hide decision.
  const slow = useSlow();
  const editing = useSyncExternalStore(editModeStore.subscribe, editModeStore.get);
  const { preview } = useScreenLayer();

  const neighbourNow = hasVisibleNeighbour(slow, config.rangeM);
  // `-Infinity` (never seen) so the linger window below can't spuriously read
  // as "recently seen" from a tiny `performance.now()` right after page load.
  const lastSeenRef = useRef(-Infinity);
  const nowMs = performance.now();
  if (neighbourNow) lastSeenRef.current = nowMs;
  const visible = neighbourNow || nowMs - lastSeenRef.current < LINGER_MS;
  // Stay visible while editing the layout (so it can be placed/moved even with
  // no one nearby) and in the manager/gallery preview (so it always shows
  // there) — exactly Flag's rule for its no-flag case.
  const hidden = !visible && !editing && !preview;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctxRef.current = ctx;

    const resize = () => {
      // The live overlay composites over the game at 1:1 with the desktop, so
      // there's no visual benefit to a >1 backing-store resolution there (see
      // isLiveOverlayWindow's doc comment) — only a GPU/memory cost. The
      // manager/gallery keep up to 2x for crisp previews on hi-DPI displays.
      const dpr = isLiveOverlayWindow() ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Gradients only depend on canvas width + the two warning colors, so
      // rebuild them here (on mount/resize/theme change) rather than per frame.
      gradsRef.current = buildGradients(ctx, sizeRef.current.w, t.loss, t.amber);
      forceRef.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [t.loss, t.amber]);

  useRafDraw(
    (_now, dtMs) => {
      const ctx = ctxRef.current;
      const grads = gradsRef.current;
      if (!ctx || !grads) return;
      const { config } = live.current;
      forceRef.current = false;
      lastConfigRef.current = config;
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const laneScale = w * 0.21; // px per ~3 m of lateral offset
      const range = config.rangeM;
      const yOf = (lon: number) => cy - (lon / range) * (h * 0.42);
      const xOf = (lat: number) => cx + (lat / 3) * laneScale;

      const slow = store.getSlow();
      lastSlowRef.current = slow;
      const playerIdx = slow?.playerCarIdx ?? null;
      const cars = (slow?.cars ?? []).filter(
        (c) =>
          !(c.isPlayer || c.carIdx === playerIdx) &&
          c.relLatM != null &&
          c.relLonM != null &&
          c.inWorld !== false
      );

      // Ease shown positions toward the latest targets — frame-rate-independent
      // exponential smoothing (dt-based, same idea as TrackMap's player-dot
      // easing) so the blips glide at a consistent visual speed regardless of
      // this widget's (now fps-capped) draw rate.
      const dtSec = Math.min(dtMs / 1000, 0.1);
      const ease = 1 - Math.exp(-dtSec / POSITION_EASE_TAU_S);
      const shown = shownRef.current;
      const seen = new Set<number>();
      // Tracks how far this frame's easing step still had left to go, so
      // dirty-skip (below) knows whether the blips have visually settled.
      let maxDelta = 0;
      for (const c of cars) {
        seen.add(c.carIdx);
        const target = { lat: c.relLatM as number, lon: c.relLonM as number };
        const cur = shown.get(c.carIdx);
        if (!cur) {
          shown.set(c.carIdx, { ...target });
          maxDelta = Infinity; // a car just appeared — definitely not settled
        } else {
          maxDelta = Math.max(maxDelta, Math.abs(target.lat - cur.lat), Math.abs(target.lon - cur.lon));
          cur.lat += (target.lat - cur.lat) * ease;
          cur.lon += (target.lon - cur.lon) * ease;
        }
      }
      for (const idx of [...shown.keys()]) if (!seen.has(idx)) shown.delete(idx);
      maxDeltaRef.current = maxDelta;

      // Edge warnings: a car alongside (both longitudinally AND laterally
      // close) on the left / right, worst tier wins per side.
      let warnL: Tier = "none";
      let warnR: Tier = "none";
      for (const b of shown.values()) {
        const tier = tierOf(b);
        if (tier === "none") continue;
        if (b.lat < 0) {
          if (TIER_RANK[tier] > TIER_RANK[warnL]) warnL = tier;
        } else if (TIER_RANK[tier] > TIER_RANK[warnR]) warnR = tier;
      }
      if (warnL !== "none") {
        ctx.fillStyle = warnL === "contact" ? grads.leftLoss : grads.leftAmber;
        ctx.fillRect(0, 0, w * 0.42, h);
      }
      if (warnR !== "none") {
        ctx.fillStyle = warnR === "contact" ? grads.rightLoss : grads.rightAmber;
        ctx.fillRect(w * 0.58, 0, w * 0.42, h);
      }

      const carW = Math.max(10, w * 0.11);
      const carH = carW * 1.6;

      // "Alongside" zone — the band level with the player where a neighbour is
      // door-to-door. Drawn first so blips and lines sit on top of it.
      const zoneTop = yOf(ALONGSIDE_M);
      const zoneBot = yOf(-ALONGSIDE_M);
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(0, zoneTop, w, zoneBot - zoneTop);

      // Range gridlines: a faint tick every ~4 m so the empty space reads as
      // scale, not dead space. Works on light and dark via a mid-grey stroke.
      ctx.strokeStyle = "rgba(128,128,128,0.22)";
      ctx.lineWidth = 1;
      const step = 4;
      for (let m = step; m <= range; m += step) {
        for (const yy of [yOf(m), yOf(-m)]) {
          const py = Math.round(yy) + 0.5;
          ctx.beginPath();
          ctx.moveTo(8, py);
          ctx.lineTo(w - 8, py);
          ctx.stroke();
        }
      }

      // Center reference line.
      ctx.strokeStyle = "rgba(128,128,128,0.3)";
      ctx.lineWidth = 1;
      const pcx = Math.round(cx) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pcx, 8);
      ctx.lineTo(pcx, h - 8);
      ctx.stroke();

      // Neighbours (only those within range). A thin outline keeps the light
      // car body legible on light backgrounds too.
      for (const b of shown.values()) {
        if (Math.abs(b.lon) > range + 3) continue;
        const x = xOf(b.lat);
        const y = yOf(b.lon);
        const tier = tierOf(b);
        roundRect(ctx, x - carW / 2, y - carH / 2, carW, carH, 3);
        ctx.fillStyle = tier === "contact" ? t.loss : tier === "caution" ? t.amber : t.text;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Player at center, with a soft accent halo.
      ctx.fillStyle = "rgba(255,45,142,0.30)";
      roundRect(ctx, cx - carW / 2 - 4, cy - carH / 2 - 4, carW + 8, carH + 8, 6);
      ctx.fill();
      ctx.fillStyle = t.accent;
      roundRect(ctx, cx - carW / 2, cy - carH / 2, carW, carH, 3);
      ctx.fill();

      // Orientation cue: a dim "ahead" marker at top so the layout (relative
      // longitudinal offset, "up" = ahead) reads at a glance without a legend.
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = "700 8px system-ui, sans-serif";
      ctx.fillStyle = "rgba(128,128,128,0.55)";
      ctx.fillText("▲ AHEAD", cx, 3);

      // Range tag: the configured half-range, so the scale is legible without
      // opening settings.
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.font = "600 8px system-ui, sans-serif";
      ctx.fillStyle = "rgba(128,128,128,0.55)";
      ctx.fillText(`${range} m`, w - 6, h - 4);
    },
    {
      // Radar is the wheel-to-wheel awareness widget — smoothness matters most
      // here, so it runs at 60fps rather than the slow-widget cap. Dirty-skip
      // (below) means it only actually paints while a blip is in motion (a car
      // genuinely nearby), so the higher rate costs GPU only in the moment the
      // smoothness is wanted and stays free when you're alone on track.
      fps: 60,
      shouldDraw: () =>
        forceRef.current ||
        store.getSlow() !== lastSlowRef.current ||
        live.current.config !== lastConfigRef.current ||
        maxDeltaRef.current > POSITION_EPSILON_M,
      // Don't spin the 60fps loop while the widget is rendering nothing — see
      // the `hidden` computation above. `enabled: true` here is a no-op for
      // every other widget that doesn't pass it.
      enabled: !hidden,
    },
    []
  );

  // Hide entirely when no neighbour is in radar range (and not editing/in
  // preview) — an empty radar is dead chrome, not information. Every hook
  // above is called unconditionally regardless of this, exactly like Flag.tsx.
  if (hidden) return null;

  // The host paints no panel chrome for this widget (`transparentPanel` in
  // `radarDef`, so the "no neighbour" case above leaves nothing behind), so we
  // paint our own panel here when actually live. While editing / in preview
  // the host / preview card still supplies the panel, so we stay transparent
  // there to avoid doubling it up — same split as Flag's `selfPanel`.
  const selfPanel = !editing && !preview;
  // Never apply backdrop-filter blur on the live overlay window (it composites
  // over the game, a different HWND it can't sample — pure GPU cost for zero
  // visible effect, see `isLiveOverlayWindow`'s doc comment and how
  // `WidgetHost`/`OverlayApp` handle their own self-painted panels). Use a
  // floored-opacity flat fill there instead, exactly mirroring `WidgetHost`'s
  // `surfaceBg`/`overlayMinAlpha` treatment.
  const overlayWindow = isLiveOverlayWindow();

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        color: t.text,
        padding: theme.widgetPad,
        boxSizing: "border-box",
        ...(selfPanel
          ? {
              background: overlayWindow ? `rgba(18, 20, 27, ${theme.overlayMinAlpha})` : t.surface,
              border: `1px solid ${t.surfaceBorder}`,
              borderRadius: theme.radius,
              backdropFilter: overlayWindow ? "none" : theme.panelBlur,
              WebkitBackdropFilter: overlayWindow ? "none" : theme.panelBlur,
              boxShadow: theme.panelShadow,
            }
          : null),
      }}
    >
      <div style={{ marginBottom: theme.space.sm }}>
        <WidgetTitle title="Radar" theme={theme} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "rgba(255,255,255,0.03)", borderRadius: 12, overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

export const radarDef: WidgetDefinition<RadarConfig> = {
  id: "radar",
  name: "Radar",
  defaultSize: { w: 150, h: 220 },
  minSize: { w: 110, h: 150 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["proximity"],
  configSchema: [{ key: "rangeM", label: "Range (m)", type: "number", min: 8, max: 40, step: 1 }],
  // The widget hides itself (renders nothing) when no neighbour is in radar
  // range, so the host must paint no panel chrome around it outside edit mode
  // — otherwise an empty panel would linger. When a neighbour is in range the
  // component paints its own panel (see `selfPanel` in the component).
  transparentPanel: () => true,
  Component: Radar,
};
