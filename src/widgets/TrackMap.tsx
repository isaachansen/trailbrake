// Track map: the circuit outline with every car as a dot at its lap-distance
// position, the player highlighted. The outline comes from the sim-provided
// normalized centerline (`slow.trackPath`); car dots are placed by mapping each
// `lapDistPct` to the corresponding point along that centerline.
//
// The baked centerline is sampled so that point index i corresponds to
// lap-distance fraction i/N (index 0 = start/finish), i.e. the points are spaced
// by lapDistPct. We therefore map a car's `lapDistPct` to its point by INDEX
// fraction (interpolating between `pts[floor(p*N)]` and the next point), not by
// cumulative geometric arc length. For the vast majority of tracks the baked
// points are also near-uniform by arc length, so the two agree to sub-pixel; but
// index mapping is the correct one and stays right on tracks whose geometry has
// long chords/discontinuities (where arc-length would misplace cars).
//
// Renders on a rAF loop so the player's own dot rides the fast-path lap distance
// (smooth) while the rest update at the slow rate. Hidden unless the sim
// provides track geometry.

import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { isLiveOverlayWindow } from "../store/windowKind";
import { classColorMap, classColorOf } from "./raceColors";
import { WidgetTitle } from "./WidgetTitle";
import { classifySessionType } from "./contract";
import { useRafDraw } from "./useRafDraw";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { FastSample, SlowSample } from "../store/types";

export interface TrackMapConfig {
  showField: boolean;
  classColors: boolean;
  showTurns: boolean;
  /** In qualifying, show only the player dot (solo hot lap — no field). */
  soloInQualy: boolean;
}

const defaultConfig: TrackMapConfig = { showField: true, classColors: false, showTurns: true, soloInQualy: true };

/**
 * Below this per-frame lap-fraction delta, a car's eased dot position is
 * "settled" for dirty-skip purposes. The track outline typically occupies a
 * path a few hundred px long on screen even on tight canvases, so a fraction
 * this small maps to a sub-pixel move — never a visible stutter when the
 * widget then goes quiet.
 */
const POSITION_EPSILON_FRAC = 0.0002;

/** A centerline whose point index i maps to lap-distance fraction i/N. */
interface PathGeom {
  pts: [number, number][];
}

function buildGeom(pts: [number, number][]): PathGeom {
  return { pts };
}

/**
 * Point on the centerline at lap-distance fraction `frac` (0..1).
 *
 * The baked points are spaced by lapDistPct (index i ≈ fraction i/N, index 0 at
 * start/finish), so we map the fraction directly to an index and interpolate to
 * the next point — closing the loop back to index 0 at frac → 1.
 */
function posAt(g: PathGeom, frac: number): [number, number] {
  const n = g.pts.length;
  if (n === 0) return [0, 0];
  const f = ((((frac % 1) + 1) % 1)) * n;
  const i = Math.floor(f) % n;
  const u = f - Math.floor(f);
  const a = g.pts[i];
  const b = g.pts[(i + 1) % n];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

function TrackMap({ theme, config }: BaseWidgetProps<TrackMapConfig>) {
  const store = useStoreInstance();
  const t = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nameRef = useRef<HTMLSpanElement | null>(null);
  const live = useRef({ config });
  live.current = { config };

  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });

  // Persistent draw-loop state (survives across draw() calls, recreated only
  // on mount — see the resize/canvas setup effect below for the sibling state
  // that's keyed off canvas identity).
  const geomRef = useRef<PathGeom | null>(null);
  const geomSrcRef = useRef<[number, number][] | null>(null);
  const boundsRef = useRef({ minX: 0, minY: 0, bw: 1, bh: 1 });
  // Per-car animated lap fraction, eased toward the slow-path target each
  // frame so the field glides instead of jumping on every slow update.
  const animPctRef = useRef(new Map<number, number>());
  // classColorMap() allocates a Map every call — cache it and only recompute
  // when the slow sample actually changes (a handful of Hz), not every draw.
  const lastSlowRef = useRef<SlowSample | null>(null);
  const cmapRef = useRef(new Map<number, string>());

  // Offscreen layer holding the STATIC geometry (track outline, start/finish
  // tick, corner numbers) — only these get re-stroked when the underlying
  // geometry/labels actually change; every draw() call just `drawImage`s this
  // cached bitmap and then paints the moving dots on top of it.
  const offCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const staticDirtyRef = useRef(true);
  const lastShowTurnsRef = useRef<boolean | undefined>(undefined);
  const lastTurnsRef = useRef<SlowSample["trackTurns"] | undefined>(undefined);

  // Dirty-skip bookkeeping. `forceRef` starts `true` (first frame always
  // paints) and is re-armed by resize() so a widget resize/DPR change is never
  // skipped even without new telemetry. `maxDeltaRef` starts at `Infinity` so
  // the widget keeps drawing until the field's easing has actually had a
  // chance to run at least once.
  const forceRef = useRef(true);
  const lastFastRef = useRef<FastSample | null | undefined>(undefined);
  const lastConfigRef = useRef<TrackMapConfig | undefined>(undefined);
  const maxDeltaRef = useRef(Infinity);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctxRef.current = ctx;

    if (!offCanvasRef.current) offCanvasRef.current = document.createElement("canvas");
    const offCanvas = offCanvasRef.current;
    const offCtx = offCanvas.getContext("2d");
    offCtxRef.current = offCtx;

    const resize = () => {
      // The live overlay composites over the game at 1:1 with the desktop, so
      // a >1 backing-store resolution buys nothing there (see
      // isLiveOverlayWindow's doc comment) — only GPU/memory cost. The
      // manager/gallery keep up to 2x for crisp previews on hi-DPI displays.
      const dpr = isLiveOverlayWindow() ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Keep the offscreen static layer pixel-identical to the main canvas so
      // `drawImage`-ing it back is a plain 1:1 copy.
      offCanvas.width = canvas.width;
      offCanvas.height = canvas.height;
      offCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      forceRef.current = true;
      staticDirtyRef.current = true; // size changed — the cached bitmap is stale
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useRafDraw(
    (_now, dtMs) => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      // Exponential smoothing toward the latest position (tau ≈ 120 ms),
      // frame-rate independent via the hook's real elapsed dtMs.
      const dt = Math.min(dtMs / 1000, 0.1);
      const ease = 1 - Math.exp(-dt / 0.12);
      const { config } = live.current;
      forceRef.current = false;
      lastConfigRef.current = config;
      lastFastRef.current = store.latestFast;
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);

      const slow = store.getSlow();
      if (slow !== lastSlowRef.current) {
        lastSlowRef.current = slow;
        cmapRef.current = classColorMap(slow?.cars ?? []);
      }
      const cmap = cmapRef.current;
      const path = slow?.trackPath ?? null;
      if (nameRef.current) setText(nameRef.current, (slow?.trackName ?? "").toUpperCase());
      if (!path || path.length < 3) {
        // Nothing to animate without geometry — let dirty-skip settle once
        // fast/slow/config also stop changing, instead of spinning forever.
        maxDeltaRef.current = 0;
        return;
      }
      const geomChanged = geomSrcRef.current !== path;
      if (geomChanged) {
        geomRef.current = buildGeom(path);
        geomSrcRef.current = path;
        // Cache the path's true bounding box so we can fill the widget with it
        // (the normalized path letterboxes itself inside 0..1, so fitting the
        // 0..1 box would leave the track small).
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [x, y] of path) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        boundsRef.current = { minX, minY, bw: maxX - minX || 1, bh: maxY - minY || 1 };
      }
      const g = geomRef.current!;
      const bounds = boundsRef.current;

      // Uniform (aspect-preserving) fit of the track's bounding box into the
      // widget: one scale for both axes (no distortion), then center. Fills the
      // available space regardless of the track's aspect ratio.
      const pad = 14;
      const s = Math.min((w - 2 * pad) / bounds.bw, (h - 2 * pad) / bounds.bh);
      const offX = (w - bounds.bw * s) / 2;
      const offY = (h - bounds.bh * s) / 2;
      const MX = (p: [number, number]) => offX + (p[0] - bounds.minX) * s;
      const MY = (p: [number, number]) => offY + (p[1] - bounds.minY) * s;

      // Static geometry (outline + start/finish tick + corner numbers) never
      // changes frame-to-frame while parked on the same track/size/settings —
      // paint it once into an offscreen layer and just `drawImage` it back
      // every frame instead of re-stroking the whole path each time.
      const turns = slow?.trackTurns ?? null;
      const staticDirty =
        staticDirtyRef.current || geomChanged || config.showTurns !== lastShowTurnsRef.current || turns !== lastTurnsRef.current;
      const offCtx = offCtxRef.current;
      if (staticDirty && offCtx) {
        offCtx.clearRect(0, 0, w, h);
        offCtx.lineJoin = "round";
        offCtx.lineCap = "round";
        const stroke = (lw: number, color: string) => {
          offCtx.beginPath();
          g.pts.forEach((p, i) => (i ? offCtx.lineTo(MX(p), MY(p)) : offCtx.moveTo(MX(p), MY(p))));
          offCtx.closePath();
          offCtx.lineWidth = lw;
          offCtx.strokeStyle = color;
          offCtx.stroke();
        };
        // Dark under-stroke (rather than a faint white one) so the bright core
        // line pops against any backdrop, including light footage.
        stroke(8, "rgba(0,0,0,0.4)");
        stroke(3.4, "rgba(255,255,255,0.5)");

        // Start/finish tick.
        const sf = posAt(g, 0);
        offCtx.fillStyle = "#fff";
        offCtx.fillRect(MX(sf) - 1.5, MY(sf) - 5, 3, 10);

        // Corner labels (positioned just off the track in the same 0..1 space).
        // Skipped entirely below ~240px wide (too little room for legible digits)
        // and, per-label, whenever its projected position lands within ~12px of
        // an already-drawn label (tight chicanes otherwise merge into "87").
        if (config.showTurns && w >= 240 && turns) {
          offCtx.font = "600 9px system-ui, sans-serif";
          offCtx.textAlign = "center";
          offCtx.textBaseline = "middle";
          const drawn: [number, number][] = [];
          for (const tn of turns) {
            const x = MX([tn.x, tn.y]);
            const y = MY([tn.x, tn.y]);
            if (drawn.some(([dx, dy]) => Math.hypot(x - dx, y - dy) < 12)) continue;
            drawn.push([x, y]);
            offCtx.lineWidth = 3;
            offCtx.strokeStyle = "rgba(0,0,0,0.55)";
            offCtx.strokeText(tn.label, x, y);
            offCtx.fillStyle = "rgba(231,235,242,0.72)";
            offCtx.fillText(tn.label, x, y);
          }
        }

        staticDirtyRef.current = false;
        lastShowTurnsRef.current = config.showTurns;
        lastTurnsRef.current = turns;
      }
      if (offCanvasRef.current) ctx.drawImage(offCanvasRef.current, 0, 0, w, h);

      const dot = (
        p: [number, number],
        rad: number,
        color: string,
        opts?: { glow?: string; outline?: string; outlineWidth?: number },
      ) => {
        const x = MX(p);
        const y = MY(p);
        if (opts?.glow) {
          ctx.fillStyle = opts.glow;
          ctx.beginPath();
          ctx.arc(x, y, rad + 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        // Dark contrasting ring so the dot reads against both the white track
        // line and the dark background.
        if (opts?.outline) {
          ctx.lineWidth = opts.outlineWidth ?? 1.4;
          ctx.strokeStyle = opts.outline;
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.stroke();
        }
      };

      const playerIdx = slow?.playerCarIdx ?? null;
      // In qualifying you run a solo hot lap — drop the field so only your own dot
      // shows (the player dot is drawn separately, below).
      const soloQualy = config.soloInQualy && classifySessionType(slow?.sessionType) === "qualy";
      // Tracks how far this frame's easing step still had left to go (circular
      // distance, matching the wrap-aware step below), so dirty-skip knows
      // whether the field has visually settled.
      let maxDelta = 0;
      if (config.showField && !soloQualy) {
        for (const c of slow?.cars ?? []) {
          if (c.isPlayer || c.carIdx === playerIdx) continue;
          // Skip cars that aren't in the world (garaged): real iRacing reports
          // these with lapDistPct === -1, which would otherwise pile every
          // garaged car onto the start/finish line.
          if (c.inWorld === false || c.lapDistPct == null || c.lapDistPct < 0) continue;
          const target = ((c.lapDistPct % 1) + 1) % 1;
          // Ease the displayed fraction toward the target along the shorter arc
          // (so a lap wrap from .99→.01 moves forward, not backward).
          const prev = animPctRef.current.get(c.carIdx);
          let shown = target;
          if (prev != null) {
            let delta = target - prev;
            delta -= Math.round(delta); // wrap to [-0.5, 0.5]
            maxDelta = Math.max(maxDelta, Math.abs(delta));
            shown = ((prev + delta * ease) % 1 + 1) % 1;
          } else {
            maxDelta = Infinity; // a car just appeared — definitely not settled
          }
          animPctRef.current.set(c.carIdx, shown);
          // Default (class colors off): a saturated amber that stands clearly
          // apart from the player's accent and the white track line.
          const color = config.classColors ? classColorOf(cmap, c.carClassId) : "#ffc24d";
          dot(posAt(g, shown), 4.3, color, { outline: "rgba(8,11,18,0.92)", outlineWidth: 1.5 });
        }
      }
      maxDeltaRef.current = maxDelta;

      // Player dot rides the fast-path lap distance for smoothness — larger,
      // accent-colored, with a glow and dark ring so the user finds it instantly.
      // Garaged (lapDistPct < 0, real iRacing reports -1) hides it, same as the
      // rest of the field above — otherwise it pins to the start/finish line.
      const pPct = store.latestFast?.lapDistPct ?? findPlayerPct(slow, playerIdx);
      if (pPct != null && pPct >= 0)
        dot(posAt(g, pPct), 5.5, t.accent, {
          glow: "rgba(255,45,142,0.4)",
          outline: "rgba(8,11,18,0.92)",
          outlineWidth: 1.6,
        });
    },
    {
      fps: 24,
      shouldDraw: () =>
        forceRef.current ||
        store.latestFast !== lastFastRef.current ||
        store.getSlow() !== lastSlowRef.current ||
        live.current.config !== lastConfigRef.current ||
        maxDeltaRef.current > POSITION_EPSILON_FRAC,
    },
    []
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box" }}>
      <div style={{ marginBottom: theme.space.sm }}>
        <WidgetTitle
          title="Track Map"
          theme={theme}
          right={<span ref={nameRef} style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "0.62em", letterSpacing: "0.06em", color: t.textDim2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, textAlign: "right" }} />}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "rgba(255,255,255,0.03)", borderRadius: 11, overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

export const trackMapDef: WidgetDefinition<TrackMapConfig> = {
  id: "track-map",
  name: "Track Map",
  defaultSize: { w: 340, h: 220 },
  minSize: { w: 160, h: 140 },
  defaultConfig,
  requiredPaths: ["slow", "fast"],
  requiredCapabilities: ["trackMap"],
  configSchema: [
    { key: "showField", label: "Show field", type: "boolean" },
    { key: "classColors", label: "Class colors", type: "boolean" },
    { key: "showTurns", label: "Corner numbers", type: "boolean" },
    { key: "soloInQualy", label: "Solo in qualy", type: "boolean" },
  ],
  Component: TrackMap,
};

function findPlayerPct(slow: SlowSample | null, playerIdx: number | null): number | null {
  const p = slow?.cars.find((c) => c.isPlayer || c.carIdx === playerIdx);
  return p?.lapDistPct ?? null;
}

function setText(el: HTMLElement | null, s: string) {
  if (el && el.textContent !== s) el.textContent = s;
}
