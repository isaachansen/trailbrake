// Flatmap: the field laid out along a single line by lap distance — a "linear
// track order" strip. Each car is a marker at its `lapDistPct`; the player is the
// pink marker. Sector ticks at 1/3 and 2/3, start/finish posts at both ends.
//
// Canvas + rAF (like Track Map): the player marker rides the fast-path lap
// distance for smoothness; the rest update at the slow rate.

import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSlow } from "../store/hooks";
import { classColorMap, classColorOf } from "./raceColors";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface FlatmapConfig {
  classColors: boolean;
}

const defaultConfig: FlatmapConfig = { classColors: true };

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

    const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    const draw = () => {
      const { config } = live.current;
      const w = cssW;
      const h = cssH;
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
      const tickH = Math.min(11, h * 0.12);
      const postH = Math.min(15, h * 0.17);

      // Lap line (spans the full marker range, post to post).
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(padX, lineY);
      ctx.lineTo(w - padX, lineY);
      ctx.stroke();

      // Sector ticks.
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      for (const s of [1 / 3, 2 / 3]) {
        const tx = Math.round(X(s)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(tx, lineY - tickH);
        ctx.lineTo(tx, lineY + tickH);
        ctx.stroke();
      }
      // Start/finish posts.
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(Math.round(padX) - 1.5, lineY - postH, 3, postH * 2);
      ctx.fillRect(Math.round(w - padX) - 1.5, lineY - postH, 3, postH * 2);

      const slow = store.getSlow();
      const playerIdx = slow?.playerCarIdx ?? null;
      const cmap = classColorMap(slow?.cars ?? []);

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
        roundRect(cx - r - 1, lineY - r - 1, 2 * r + 2, 2 * r + 2, (r + 1) * 0.55);
        ctx.fill();
        ctx.fillStyle = color;
        roundRect(cx - r, lineY - r, 2 * r, 2 * r, r * 0.55);
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

      const pPct =
        store.latestFast?.lapDistPct ??
        slow?.cars.find((c) => c.isPlayer || c.carIdx === playerIdx)?.lapDistPct ??
        null;
      if (pPct != null) marker(pPct, t.accent, playerR, true);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [t.accent, store]);

  const legendDot = (label: string, color: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color, fontWeight: 600, fontSize: "0.62em" }}>● {label}</span>
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "8px 12px 9px", boxSizing: "border-box" }}>
      <div style={{ marginBottom: 5 }}>
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
  requiredCapabilities: ["relativeGaps"],
  configSchema: [{ key: "classColors", label: "Class colors", type: "boolean" }],
  Component: Flatmap,
};
