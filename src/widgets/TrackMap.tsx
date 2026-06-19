// Track map: the circuit outline with every car as a dot at its lap-distance
// position, the player highlighted. The outline comes from the sim-provided
// normalized centerline (`slow.trackPath`); car dots are placed by mapping each
// `lapDistPct` to a point along that centerline's arc length.
//
// Renders on a rAF loop so the player's own dot rides the fast-path lap distance
// (smooth) while the rest update at the slow rate. Hidden unless the sim
// provides track geometry.

import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { classColorMap, classColorOf } from "./raceColors";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { SlowSample } from "../store/types";

export interface TrackMapConfig {
  showField: boolean;
  classColors: boolean;
  showTurns: boolean;
}

const defaultConfig: TrackMapConfig = { showField: true, classColors: false, showTurns: true };

/** Precomputed cumulative arc length for a centerline, for pct→point mapping. */
interface PathGeom {
  pts: [number, number][];
  cum: number[];
  total: number;
}

function buildGeom(pts: [number, number][]): PathGeom {
  const cum = [0];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum.push(total);
  }
  return { pts, cum, total };
}

/** Point on the centerline at fraction `frac` (0..1) of the lap. */
function posAt(g: PathGeom, frac: number): [number, number] {
  const d = (((frac % 1) + 1) % 1) * g.total;
  for (let i = 0; i < g.cum.length - 1; i++) {
    if (d <= g.cum[i + 1]) {
      const seg = g.cum[i + 1] - g.cum[i] || 1;
      const u = (d - g.cum[i]) / seg;
      const a = g.pts[i];
      const b = g.pts[(i + 1) % g.pts.length];
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
  }
  return g.pts[0];
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

      const dot = (p: [number, number], rad: number, color: string, glow?: string) => {
        const x = MX(p);
        const y = MY(p);
        if (glow) {
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, rad + 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      };

      const playerIdx = slow?.playerCarIdx ?? null;
      const cmap = classColorMap(slow?.cars ?? []);
      if (config.showField) {
        for (const c of slow?.cars ?? []) {
          if (c.isPlayer || c.carIdx === playerIdx || c.lapDistPct == null) continue;
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
          const color = config.classColors ? classColorOf(cmap, c.carClassId) : "#e7ebf2";
          dot(posAt(g, shown), 3.2, color);
        }
      }

      // Player dot rides the fast-path lap distance for smoothness.
      const pPct = store.latestFast?.lapDistPct ?? findPlayerPct(slow, playerIdx);
      if (pPct != null) dot(posAt(g, pPct), 5, t.accent, "rgba(255,45,142,0.4)");

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>TRACK MAP</span>
        <span ref={nameRef} style={{ marginLeft: "auto", fontWeight: 600, fontSize: "0.62em", letterSpacing: "0.06em", color: t.textDim2 }} />
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
