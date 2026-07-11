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
import { sectorColorKey, sectorStrokeColor } from "./sectorColors";
import { WidgetTitle } from "./WidgetTitle";
import { classifySessionType } from "./contract";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { Sectors, SlowSample } from "../store/types";

export interface TrackMapConfig {
  showField: boolean;
  classColors: boolean;
  /** In qualifying, show only the player dot (solo hot lap — no field). */
  soloInQualy: boolean;
  /**
   * Reference for sector arc colors — same semantics as Sector Delta.
   * Only completed sectors this lap are colored; incomplete stay neutral.
   */
  sectorReference: "personal" | "session" | "ghost";
}

const defaultConfig: TrackMapConfig = {
  showField: true,
  classColors: false,
  soloInQualy: true,
  sectorReference: "ghost",
};

function hasAnySector(s: Sectors): boolean {
  return s.s1 != null || s.s2 != null || s.s3 != null;
}

/** Ghost → session → personal fallthrough when the preferred splits are missing. */
function resolveSectorReference(
  requested: TrackMapConfig["sectorReference"],
  slow: SlowSample
): TrackMapConfig["sectorReference"] {
  if (requested !== "ghost") return requested;
  if (hasAnySector(slow.sectorGhostBestS)) return "ghost";
  if (hasAnySector(slow.sectorSessionBestS)) return "session";
  return "personal";
}

function sectorRefSplit(slow: SlowSample, mode: TrackMapConfig["sectorReference"], idx: 0 | 1 | 2): number | null {
  const key = (["s1", "s2", "s3"] as const)[idx];
  if (mode === "ghost") return slow.sectorGhostBestS[key];
  if (mode === "session") return slow.sectorSessionBestS[key] ?? slow.sectorBestS[key];
  return slow.sectorBestS[key];
}

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

/**
 * Unit tangent of the centerline at `frac` (direction of travel). Uniform
 * screen scale means the same vector is the screen-space tangent, so the
 * perpendicular `[-ty, tx]` is a true cross-track tick.
 */
function tangentAt(g: PathGeom, frac: number): [number, number] {
  const n = g.pts.length;
  if (n < 2) return [1, 0];
  const f = ((((frac % 1) + 1) % 1)) * n;
  const i0 = Math.floor(f) % n;
  // Prefer the local segment; if it's degenerate (duplicate points), walk
  // neighbors until we get a usable chord.
  for (let k = 0; k < n; k++) {
    const a = g.pts[(i0 + k) % n];
    const b = g.pts[(i0 + k + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) return [dx / len, dy / len];
  }
  return [1, 0];
}

/** Short cross-track tick centered on `(x,y)`, perpendicular to unit tangent `tan`. */
function drawCrossTrackTick(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tan: [number, number],
  halfLen: number,
  width: number,
  color: string,
) {
  const nx = -tan[1];
  const ny = tan[0];
  ctx.beginPath();
  ctx.moveTo(x - nx * halfLen, y - ny * halfLen);
  ctx.lineTo(x + nx * halfLen, y + ny * halfLen);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "butt";
  ctx.stroke();
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
    // classColorMap() allocates a Map every call — cache it and only recompute
    // when the slow sample actually changes (a handful of Hz), not every rAF
    // frame (60Hz), since store.getSlow() returns a fresh reference each tick.
    let lastSlow: SlowSample | null = null;
    let cmap = new Map<number, string>();

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
      if (slow !== lastSlow) {
        lastSlow = slow;
        cmap = classColorMap(slow?.cars ?? []);
      }
      const path = slow?.trackPath ?? null;
      if (nameRef.current) setText(nameRef.current, (slow?.trackName ?? "").toUpperCase());
      if (!path || path.length < 3) {
        const reason = slow?.trackMetadata?.unsupportedReason;
        if (reason && w > 0 && h > 0) {
          ctx.fillStyle = t.textDim;
          ctx.font = `600 ${Math.max(10, Math.round(h * 0.07))}px ${theme.font.label}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const words = reason.split(" ");
          let line = "";
          const lines: string[] = [];
          for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > w - 24 && line) {
              lines.push(line);
              line = word;
            } else line = test;
          }
          if (line) lines.push(line);
          const lh = Math.max(12, h * 0.09);
          const y0 = h / 2 - ((lines.length - 1) * lh) / 2;
          lines.forEach((ln, i) => ctx.fillText(ln, w / 2, y0 + i * lh));
        }
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

      const sectorStarts = (() => {
        const meta = slow?.trackMetadata?.sectors ?? [];
        if (meta.length >= 2) return [0, ...meta.slice(1).map((s) => s.marker), 1];
        return [0, 0.33, 0.66, 1];
      })();
      // Sector arcs: only color AFTER this lap's split is in — same meaning as
      // Sector Delta (purple/green/amber/red vs the chosen reference). Incomplete
      // / current / ahead sectors stay neutral so the map never implies a result
      // you haven't earned yet.
      const sectorTimes = [slow?.sectorTimesS?.s1 ?? null, slow?.sectorTimesS?.s2 ?? null, slow?.sectorTimesS?.s3 ?? null];
      const refMode = slow != null ? resolveSectorReference(config.sectorReference ?? "ghost", slow) : "personal";
      const nPts = g.pts.length;
      for (let si = 0; si < 3; si++) {
        const f0 = sectorStarts[si] ?? si / 3;
        const f1 = sectorStarts[si + 1] ?? (si + 1) / 3;
        let i0 = Math.floor(f0 * nPts) % nPts;
        let i1 = Math.floor(f1 * nPts) % nPts;
        ctx.beginPath();
        let first = true;
        const step = i0 <= i1 ? 1 : 1;
        for (let stepI = 0, idx = i0; stepI <= nPts; stepI++, idx = (idx + step) % nPts) {
          const p = g.pts[idx];
          if (first) {
            ctx.moveTo(MX(p), MY(p));
            first = false;
          } else ctx.lineTo(MX(p), MY(p));
          if (idx === i1) break;
          if (stepI >= nPts) break;
        }
        const cur = sectorTimes[si];
        const ref = slow != null ? sectorRefSplit(slow, refMode, si as 0 | 1 | 2) : null;
        // No current-lap split → dim. Never paint from previous-lap or live guess.
        const colorKey = cur != null ? sectorColorKey(cur, ref) : "dim";
        ctx.lineWidth = 6;
        ctx.strokeStyle = sectorStrokeColor(t, colorKey);
        ctx.stroke();
      }

      for (let si = 1; si < sectorStarts.length - 1; si++) {
        const frac = sectorStarts[si];
        const p = posAt(g, frac);
        drawCrossTrackTick(
          ctx,
          MX(p),
          MY(p),
          tangentAt(g, frac),
          4,
          2,
          "rgba(255,255,255,0.85)",
        );
      }

      const stroke = (lw: number, color: string) => {
        ctx.beginPath();
        g.pts.forEach((p, i) => (i ? ctx.lineTo(MX(p), MY(p)) : ctx.moveTo(MX(p), MY(p))));
        ctx.closePath();
        ctx.lineCap = "round";
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.stroke();
      };
      // Dark under-stroke (rather than a faint white one) so the bright core
      // line pops against any backdrop, including light footage.
      stroke(8, "rgba(0,0,0,0.4)");
      stroke(3.4, "rgba(255,255,255,0.5)");

      // Start/finish tick — same cross-track treatment as sector markers.
      const sf = posAt(g, 0);
      drawCrossTrackTick(ctx, MX(sf), MY(sf), tangentAt(g, 0), 5, 3, "#fff");

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
      // Garaged (lapDistPct < 0, real iRacing reports -1) hides it, same as the
      // rest of the field above — otherwise it pins to the start/finish line.
      const pPct = store.latestFast?.lapDistPct ?? findPlayerPct(slow, playerIdx);
      if (pPct != null && pPct >= 0)
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
    { key: "soloInQualy", label: "Solo in qualy", type: "boolean" },
    {
      key: "sectorReference",
      label: "Sector colors vs",
      type: "enum",
      options: [
        { value: "ghost", label: "Reference Lap" },
        { value: "session", label: "Session Best" },
        { value: "personal", label: "Personal Best" },
      ],
    },
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
