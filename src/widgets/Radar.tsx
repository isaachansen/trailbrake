// Radar: a spotter's-eye proximity view of cars right next to you. Each car is
// placed by its lateral / longitudinal offset (meters) relative to the player;
// the player sits fixed at center. Cars that draw alongside turn red and light
// the corresponding screen edge — the "don't turn in" warning.
//
// The data (relLatM/relLonM) is slow-path, but rendering runs on a rAF loop that
// eases the drawn positions toward the latest sample, so the blips glide instead
// of snapping at the 5 Hz update rate. Hidden unless the sim provides proximity.

import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface RadarConfig {
  /** Half-range shown above/below the player, in meters. */
  rangeM: number;
}

const defaultConfig: RadarConfig = { rangeM: 16 };

/** Longitudinal distance (m) within which a neighbour counts as "alongside". */
const ALONGSIDE_M = 3;

interface Blip {
  lat: number;
  lon: number;
}

function Radar({ theme, config }: BaseWidgetProps<RadarConfig>) {
  const store = useStoreInstance();
  const t = theme.colors;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

    // Eased positions per car, keyed by carIdx.
    const shown = new Map<number, Blip>();

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

      const cx = w / 2;
      const cy = h / 2;
      const laneScale = w * 0.21; // px per ~3 m of lateral offset
      const range = config.rangeM;
      const yOf = (lon: number) => cy - (lon / range) * (h * 0.42);
      const xOf = (lat: number) => cx + (lat / 3) * laneScale;

      const slow = store.getSlow();
      const playerIdx = slow?.playerCarIdx ?? null;
      const cars = (slow?.cars ?? []).filter(
        (c) => !(c.isPlayer || c.carIdx === playerIdx) && c.relLatM != null && c.relLonM != null
      );

      // Ease shown positions toward the latest targets.
      const seen = new Set<number>();
      for (const c of cars) {
        seen.add(c.carIdx);
        const target = { lat: c.relLatM as number, lon: c.relLonM as number };
        const cur = shown.get(c.carIdx);
        if (!cur) shown.set(c.carIdx, { ...target });
        else {
          cur.lat += (target.lat - cur.lat) * 0.25;
          cur.lon += (target.lon - cur.lon) * 0.25;
        }
      }
      for (const idx of [...shown.keys()]) if (!seen.has(idx)) shown.delete(idx);

      // Edge warnings: a car alongside on the left / right.
      let warnL = false;
      let warnR = false;
      for (const b of shown.values()) {
        if (Math.abs(b.lon) < ALONGSIDE_M) {
          if (b.lat < 0) warnL = true;
          else warnR = true;
        }
      }
      if (warnL) {
        const g = ctx.createLinearGradient(0, 0, w * 0.42, 0);
        g.addColorStop(0, "rgba(255,73,94,0.5)");
        g.addColorStop(1, "rgba(255,73,94,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w * 0.42, h);
      }
      if (warnR) {
        const g = ctx.createLinearGradient(w, 0, w * 0.58, 0);
        g.addColorStop(0, "rgba(255,73,94,0.5)");
        g.addColorStop(1, "rgba(255,73,94,0)");
        ctx.fillStyle = g;
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
        const alongside = Math.abs(b.lon) < ALONGSIDE_M;
        roundRect(x - carW / 2, y - carH / 2, carW, carH, 3);
        ctx.fillStyle = alongside ? t.loss : "#e7ebf2";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Player at center, with a soft accent halo.
      ctx.fillStyle = "rgba(255,45,142,0.30)";
      roundRect(cx - carW / 2 - 4, cy - carH / 2 - 4, carW + 8, carH + 8, 6);
      ctx.fill();
      ctx.fillStyle = t.accent;
      roundRect(cx - carW / 2, cy - carH / 2, carW, carH, 3);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [t.loss, t.accent]);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "7px 9px 9px", boxSizing: "border-box" }}>
      <div style={{ marginBottom: 5 }}>
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
  Component: Radar,
};
