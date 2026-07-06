// Flatmap: the field laid out along a single line by lap distance — a "linear
// track order" strip. Each car is a marker at its `lapDistPct`; the player is the
// pink marker. Sector ticks at 1/3 and 2/3, start/finish posts at both ends.
//
// Canvas + rAF (like Track Map): the player marker rides the fast-path lap
// distance for smoothness; the rest update at the slow rate.

import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSlow } from "../store/hooks";
import { isLiveOverlayWindow } from "../store/windowKind";
import { classColorMap, classColorOf } from "./raceColors";
import { WidgetTitle } from "./WidgetTitle";
import { useRafDraw } from "./useRafDraw";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { FastSample, SlowSample } from "../store/types";

export interface FlatmapConfig {
  classColors: boolean;
}

const defaultConfig: FlatmapConfig = { classColors: true };

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function Flatmap({ theme, config }: BaseWidgetProps<FlatmapConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const slow = useSlow();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ config });
  live.current = { config };

  // Legend reflects only the classes actually in the field (not a fixed list),
  // colored from the app palette (blue/purple/green/red) by class order.
  const ccol = classColorMap(slow?.cars ?? []);
  const legend: { name: string; color: string }[] = [];
  const seen = new Set<string>();
  for (const c of slow?.cars ?? []) {
    if (c.carClassName && !seen.has(c.carClassName)) {
      seen.add(c.carClassName);
      legend.push({ name: c.carClassName, color: classColorOf(ccol, c.carClassId) });
    }
  }

  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  // classColorMap() allocates a Map every call — cache it and only recompute
  // when the slow sample actually changes (a handful of Hz), not every draw.
  const lastSlowRef = useRef<SlowSample | null>(null);
  const cmapRef = useRef(new Map<number, string>());

  // Offscreen layer holding the STATIC geometry (lap line, sector ticks,
  // start/finish posts) — purely a function of the widget's size, so it only
  // needs rebuilding on resize. Every draw() call just `drawImage`s it back
  // and paints the moving markers on top.
  const offCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const staticDirtyRef = useRef(true);

  // Dirty-skip bookkeeping. `forceRef` starts `true` (first frame always
  // paints) and is re-armed by resize(). Flatmap has no eased/interpolated
  // state (markers snap straight to the latest lapDistPct), so unlike
  // Radar/TrackMap there's no convergence check needed — just "did the inputs
  // change". `undefined`-initialized refs guarantee the first check mismatches.
  const forceRef = useRef(true);
  const lastFastRef = useRef<FastSample | null | undefined>(undefined);
  const lastConfigRef = useRef<FlatmapConfig | undefined>(undefined);

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
    () => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const { config } = live.current;
      forceRef.current = false;
      lastConfigRef.current = config;
      lastFastRef.current = store.latestFast;
      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);

      // `padX` reserves room for the start/finish posts; `inset` keeps car
      // markers (and the player glow) clear of those posts and the box edge so a
      // car at 0%/100% never collides with the post or gets clipped.
      const playerR = 7;
      const glowR = playerR + 5;
      const padX = Math.min(22, w * 0.06);
      const inset = padX + glowR;
      const lineY = Math.round(h * 0.5) + 0.5;
      const span = Math.max(1, w - 2 * inset);
      const X = (f: number) => inset + (((f % 1) + 1) % 1) * span;
      // Scale with the widget's actual height (was capped at 11/15px, which
      // left most of the default 130px-tall canvas as dead space) so posts and
      // ticks stay proportionate at any size.
      const tickH = Math.max(8, Math.min(h * 0.28, 34));
      const postH = Math.max(11, Math.min(h * 0.38, 42));

      // Static geometry (lap line, sector ticks, start/finish posts) never
      // changes frame-to-frame at a fixed size — paint it once into an
      // offscreen layer and `drawImage` it back instead of re-stroking it
      // every frame.
      const offCtx = offCtxRef.current;
      if (staticDirtyRef.current && offCtx) {
        offCtx.clearRect(0, 0, w, h);
        // Lap line (spans the full marker range, post to post). Mid-grey (not
        // white-alpha) so it stays visible over light backdrops too.
        offCtx.strokeStyle = "rgba(128,128,128,0.4)";
        offCtx.lineWidth = 2;
        offCtx.beginPath();
        offCtx.moveTo(padX, lineY);
        offCtx.lineTo(w - padX, lineY);
        offCtx.stroke();

        // Sector ticks.
        offCtx.strokeStyle = "rgba(128,128,128,0.45)";
        offCtx.lineWidth = 1;
        for (const s of [1 / 3, 2 / 3]) {
          const tx = Math.round(X(s)) + 0.5;
          offCtx.beginPath();
          offCtx.moveTo(tx, lineY - tickH);
          offCtx.lineTo(tx, lineY + tickH);
          offCtx.stroke();
        }
        // Start/finish posts.
        offCtx.fillStyle = "rgba(255,255,255,0.55)";
        offCtx.fillRect(Math.round(padX) - 1.5, lineY - postH, 3, postH * 2);
        offCtx.fillRect(Math.round(w - padX) - 1.5, lineY - postH, 3, postH * 2);

        staticDirtyRef.current = false;
      }
      if (offCanvasRef.current) ctx.drawImage(offCanvasRef.current, 0, 0, w, h);

      const slow = store.getSlow();
      if (slow !== lastSlowRef.current) {
        lastSlowRef.current = slow;
        cmapRef.current = classColorMap(slow?.cars ?? []);
      }
      const cmap = cmapRef.current;
      const playerIdx = slow?.playerCarIdx ?? null;

      const marker = (f: number, color: string, r: number, player: boolean) => {
        const cx = X(f);
        if (player) {
          ctx.fillStyle = "rgba(255,45,142,0.35)";
          ctx.beginPath();
          ctx.arc(cx, lineY, glowR, 0, Math.PI * 2);
          ctx.fill();
        }
        // Thin dark rim keeps adjacent / overlapping same-class markers distinct.
        ctx.fillStyle = "rgba(15,18,24,0.85)";
        roundRect(ctx, cx - r - 1, lineY - r - 1, 2 * r + 2, 2 * r + 2, (r + 1) * 0.55);
        ctx.fill();
        ctx.fillStyle = color;
        roundRect(ctx, cx - r, lineY - r, 2 * r, 2 * r, r * 0.55);
        ctx.fill();
      };

      // At small widths shrink field markers so the pack stays readable.
      const fieldR = Math.max(4, Math.min(5, span / 90));

      for (const c of slow?.cars ?? []) {
        if (c.isPlayer || c.carIdx === playerIdx) continue;
        // Skip garaged cars (not in world): real iRacing reports lapDistPct === -1
        // for these, which would otherwise stack them on the start/finish post.
        if (c.inWorld === false || c.lapDistPct == null || c.lapDistPct < 0) continue;
        const color = config.classColors ? classColorOf(cmap, c.carClassId) : "#e7ebf2";
        marker(c.lapDistPct, color, fieldR, false);
      }

      // Garaged (lapDistPct < 0, real iRacing reports -1) hides the player
      // marker, same as the rest of the field above — otherwise it pins to the
      // start/finish post.
      const pPct =
        store.latestFast?.lapDistPct ??
        slow?.cars.find((c) => c.isPlayer || c.carIdx === playerIdx)?.lapDistPct ??
        null;
      if (pPct != null && pPct >= 0) marker(pPct, t.accent, playerR, true);
    },
    {
      fps: 24,
      shouldDraw: () =>
        forceRef.current ||
        store.latestFast !== lastFastRef.current ||
        store.getSlow() !== lastSlowRef.current ||
        live.current.config !== lastConfigRef.current,
    },
    []
  );

  const legendDot = (label: string, color: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color, fontWeight: 600, fontSize: "0.62em" }}>● {label}</span>
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box" }}>
      <div style={{ marginBottom: theme.space.sm }}>
        <WidgetTitle
          title="Track Order"
          theme={theme}
          right={
            <div style={{ display: "flex", gap: 11 }}>
              {legend.map((c) => (
                <span key={c.name}>{legendDot(c.name, c.color)}</span>
              ))}
            </div>
          }
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "rgba(255,255,255,0.03)", borderRadius: 11, overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

export const flatmapDef: WidgetDefinition<FlatmapConfig> = {
  id: "flatmap",
  name: "Flatmap",
  defaultSize: { w: 560, h: 130 },
  minSize: { w: 260, h: 90 },
  defaultConfig,
  requiredPaths: ["slow", "fast"],
  // Unlike Relative/Standings/SlowCarAhead, this widget never reads a gap or
  // delta field — it only positions cars by `cars[].lapDistPct`, which every
  // backend populates unconditionally alongside the car list. There's no
  // capability flag for that, so it honestly requires none (`relativeGaps` was
  // a mismatch: gating on a capability the widget doesn't actually use).
  requiredCapabilities: [],
  configSchema: [{ key: "classColors", label: "Class colors", type: "boolean" }],
  Component: Flatmap,
};
