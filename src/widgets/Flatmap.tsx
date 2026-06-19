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

      const padX = 16;
      const lineY = h * 0.5;
      const X = (f: number) => padX + (((f % 1) + 1) % 1) * (w - 2 * padX);

      // Lap line.
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
        ctx.beginPath();
        ctx.moveTo(X(s), lineY - 11);
        ctx.lineTo(X(s), lineY + 11);
        ctx.stroke();
      }
      // Start/finish posts.
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(padX - 1.5, lineY - 15, 3, 30);
      ctx.fillRect(w - padX - 1.5, lineY - 15, 3, 30);

      const slow = store.getSlow();
      const playerIdx = slow?.playerCarIdx ?? null;
      const cmap = classColorMap(slow?.cars ?? []);

      const marker = (f: number, color: string, r: number, player: boolean) => {
        const cx = X(f);
        if (player) {
          ctx.fillStyle = "rgba(255,45,142,0.35)";
          ctx.beginPath();
          ctx.arc(cx, lineY, r + 5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = color;
        roundRect(cx - r, lineY - r, 2 * r, 2 * r, r * 0.55);
        ctx.fill();
      };

      for (const c of slow?.cars ?? []) {
        if (c.isPlayer || c.carIdx === playerIdx || c.lapDistPct == null) continue;
        const color = config.classColors ? classColorOf(cmap, c.carClassId) : "#e7ebf2";
        marker(c.lapDistPct, color, 5, false);
      }

      const pPct =
        store.latestFast?.lapDistPct ??
        slow?.cars.find((c) => c.isPlayer || c.carIdx === playerIdx)?.lapDistPct ??
        null;
      if (pPct != null) marker(pPct, t.accent, 7, true);

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <span style={{ fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>TRACK ORDER</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 11 }}>
          {legend.map((c) => (
            <span key={c.name}>{legendDot(c.name, c.color)}</span>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "rgba(255,255,255,0.03)", borderRadius: 11, overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontWeight: 600, fontSize: "0.56em", letterSpacing: "0.16em", color: t.textDim2 }}>
        <span>S/F</span>
        <span>SECTOR 1 · 2 · 3</span>
        <span>S/F</span>
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
