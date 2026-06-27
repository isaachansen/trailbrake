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
import { classColorMap, classColorOf } from "./raceColors";
import { WidgetTitle } from "./WidgetTitle";
import { classifySessionType } from "./contract";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { SlowSample } from "../store/types";

export interface TrackMapConfig {
  showField: boolean;
  classColors: boolean;
  showTurns: boolean;
  /** In qualifying, show only the player dot (solo hot lap — no field). */
  soloInQualy: boolean;
}

const defaultConfig: TrackMapConfig = { showField: true, classColors: false, showTurns: true, soloInQualy: true };

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let cssW = 0;
    let cssH = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      cssW = r.width;
      cssH = r.height;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let geom: PathGeom | null = null;
    let geomSrc: [number, number][] | null = null;
    let bounds = { minX: 0, minY: 0, bw: 1, bh: 1 };
    // Per-car animated lap fraction, eased toward the slow-path target each
    // frame so the field glides instead of jumping on every slow update.
    const animPct = new Map<number, number>();
    let lastT = 0;

    const draw = (now: number) => {
      const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
      lastT = now;
      // Exponential smoothing toward the latest position (tau ≈ 120 ms).
      const ease = 1 - Math.exp(-dt / 0.12);
      const { config } = live.current;
      const w = cssW;
      const h = cssH;
      ctx.clearRect(0, 0, w, h);

      const slow = store.getSlow();
      const path = slow?.trackPath ?? null;
      if (nameRef.current) setText(nameRef.current, (slow?.trackName ?? "").toUpperCase());
      if (!path || path.length < 3) {
        raf = requestAnimationFrame(draw);
        return;
      }
      if (geomSrc !== path) {
        geom = buildGeom(path);
        geomSrc = path;
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
        bounds = { minX, minY, bw: maxX - minX || 1, bh: maxY - minY || 1 };
      }
      const g = geom!;

      // Uniform (aspect-preserving) fit of the track's bounding box into the
      // widget: one scale for both axes (no distortion), then center. Fills the
      // available space regardless of the track's aspect ratio.
      const pad = 14;
      const s = Math.min((w - 2 * pad) / bounds.bw, (h - 2 * pad) / bounds.bh);
      const offX = (w - bounds.bw * s) / 2;
      const offY = (h - bounds.bh * s) / 2;
      const MX = (p: [number, number]) => offX + (p[0] - bounds.minX) * s;
      const MY = (p: [number, number]) => offY + (p[1] - bounds.minY) * s;

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      const stroke = (lw: number, color: string) => {
        ctx.beginPath();
        g.pts.forEach((p, i) => (i ? ctx.lineTo(MX(p), MY(p)) : ctx.moveTo(MX(p), MY(p))));
        ctx.closePath();
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.stroke();
      };
      stroke(8, "rgba(255,255,255,0.10)");
      stroke(3.4, "rgba(255,255,255,0.5)");

      // Start/finish tick.
      const sf = posAt(g, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(MX(sf) - 1.5, MY(sf) - 5, 3, 10);

      // Corner labels (positioned just off the track in the same 0..1 space).
      if (config.showTurns) {
        const turns = slow?.trackTurns ?? null;
        if (turns) {
          ctx.font = "600 9px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          for (const tn of turns) {
            const x = MX([tn.x, tn.y]);
            const y = MY([tn.x, tn.y]);
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(0,0,0,0.55)";
            ctx.strokeText(tn.label, x, y);
            ctx.fillStyle = "rgba(231,235,242,0.72)";
            ctx.fillText(tn.label, x, y);
          }
        }
      }

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
      const cmap = classColorMap(slow?.cars ?? []);
      // In qualifying you run a solo hot lap — drop the field so only your own dot
      // shows (the player dot is drawn separately, below).
      const soloQualy = config.soloInQualy && classifySessionType(slow?.sessionType) === "qualy";
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
          const prev = animPct.get(c.carIdx);
          let shown = target;
          if (prev != null) {
            let delta = target - prev;
            delta -= Math.round(delta); // wrap to [-0.5, 0.5]
            shown = ((prev + delta * ease) % 1 + 1) % 1;
          }
          animPct.set(c.carIdx, shown);
          // Default (class colors off): a saturated amber that stands clearly
          // apart from the player's accent and the white track line.
          const color = config.classColors ? classColorOf(cmap, c.carClassId) : "#ffc24d";
          dot(posAt(g, shown), 4.3, color, { outline: "rgba(8,11,18,0.92)", outlineWidth: 1.5 });
        }
      }

      // Player dot rides the fast-path lap distance for smoothness — larger,
      // accent-colored, with a glow and dark ring so the user finds it instantly.
      const pPct = store.latestFast?.lapDistPct ?? findPlayerPct(slow, playerIdx);
      if (pPct != null)
        dot(posAt(g, pPct), 5.5, t.accent, {
          glow: "rgba(255,45,142,0.4)",
          outline: "rgba(8,11,18,0.92)",
          outlineWidth: 1.6,
        });

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [t.accent]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "8px 11px 11px", boxSizing: "border-box" }}>
      <div style={{ marginBottom: 6 }}>
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
