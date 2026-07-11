// Shared RPM shift-light strip used by Dash Cluster and Tachometer.
// Per-car thresholds/colors come from Lovely Car Data via `carLeds.ts`.

import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { gearLeds, type CarLeds } from "./carLeds";

export const FALLBACK_LED_COUNT = 16;

export type ShiftLedShape = "line" | "circle" | "triangle";

export const SHIFT_LED_SHAPE_OPTIONS: { value: ShiftLedShape; label: string }[] = [
  { value: "line", label: "Lines" },
  { value: "circle", label: "Circles" },
  { value: "triangle", label: "Triangles" },
];

export interface ShiftLedThemeColors {
  accent: string;
  throttle: string;
  loss: string;
}

/** Rounded-up triangle mask (pointing up) — soft corners like a real dash LED. */
const TRIANGLE_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 11"><path fill="black" d="M6 1.05c.38 0 .73.2.92.52l4.15 7.05c.22.37.2.83-.05 1.17-.15.2-.38.31-.62.31H1.6c-.24 0-.47-.11-.62-.31a1.05 1.05 0 0 1-.05-1.17L5.08 1.57A1.05 1.05 0 0 1 6 1.05z"/></svg>`,
)}")`;

const OFF_BG = "rgba(255,255,255,0.08)";

/** One LED cell — shape is structural; on/off color is painted via refs. */
export function ShiftLedStrip({
  ledCount,
  shape,
  ledRefs,
  style,
}: {
  ledCount: number;
  shape: ShiftLedShape;
  ledRefs: MutableRefObject<(HTMLDivElement | null)[]>;
  style?: CSSProperties;
}) {
  const gap = shape === "line" ? 4 : 3;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [ledPx, setLedPx] = useState(16);
  const heightConstrained = style?.height != null || style?.maxHeight != null;

  useEffect(() => {
    if (shape === "line") return;
    const el = stripRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const slot = (w - gap * Math.max(0, ledCount - 1)) / Math.max(1, ledCount);
      const h = el.clientHeight;
      const px = Math.max(
        4,
        Math.floor(heightConstrained && h > 0 ? Math.min(slot, h) : slot),
      );
      setLedPx((prev) => (prev === px ? prev : px));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shape, ledCount, gap, heightConstrained]);

  return (
    <div
      key={`${ledCount}-${shape}`}
      ref={stripRef}
      style={{
        display: "flex",
        gap,
        width: "100%",
        alignItems: "center",
        // Circles/triangles are fixed-px; center the group when the strip is wider.
        justifyContent: shape === "line" ? undefined : "center",
        ...style,
      }}
    >
      {Array.from({ length: ledCount }, (_, i) => {
        if (shape === "line") {
          return (
            <div
              key={i}
              ref={(el) => {
                ledRefs.current[i] = el;
              }}
              style={{
                flex: 1,
                height: 8,
                minWidth: 0,
                borderRadius: 3,
                background: OFF_BG,
              }}
            />
          );
        }

        if (shape === "circle") {
          // Real SVG circle — cannot become an oval from flex/box stretch.
          return (
            <svg
              key={i}
              width={ledPx}
              height={ledPx}
              viewBox="0 0 10 10"
              style={{ flexShrink: 0, overflow: "visible", display: "block" }}
              aria-hidden
            >
              <circle
                ref={(el) => {
                  // paintShiftLeds writes background/filter onto HTMLElement;
                  // for SVG we paint fill + filter on the <circle> via the same ref slot
                  // by storing the circle element cast as HTMLDivElement for the painter.
                  ledRefs.current[i] = el as unknown as HTMLDivElement;
                }}
                cx="5"
                cy="5"
                r="4.7"
                fill={OFF_BG}
              />
            </svg>
          );
        }

        // triangle
        return (
          <div
            key={i}
            ref={(el) => {
              ledRefs.current[i] = el;
            }}
            style={{
              width: ledPx,
              height: ledPx,
              flexShrink: 0,
              background: OFF_BG,
              WebkitMaskImage: TRIANGLE_MASK,
              maskImage: TRIANGLE_MASK,
              WebkitMaskSize: "100% 100%",
              maskSize: "100% 100%",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
              transform: i % 2 === 1 ? "rotate(180deg)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

/** Paint one frame of shift lights into DOM refs (fast-path, no React).
 *
 * Priority for blink/redline threshold (matches irDashies):
 *   1. `sdkBlinkRpm`  — iRacing `DriverCarSLBlinkRPM` (session YAML)
 *   2. `sdkRedline`   — iRacing `DriverCarRedLine`    (session YAML)
 *   3. Profile gear redline — Lovely car data per-gear threshold
 *   4. `fallbackRedline`   — widget config value (user-set, default 8500)
 *
 * For the fallback (no profile) gauge scale:
 *   1. `sdkRedline`   — iRacing `DriverCarRedLine`
 *   2. `fallbackRedline` — widget config value
 */
export function paintShiftLeds(
  ledRefs: (HTMLDivElement | null)[],
  ledCount: number,
  rpm: number,
  gear: number | null | undefined,
  profile: CarLeds | null,
  fallbackRedline: number,
  colors: ShiftLedThemeColors,
  shape: ShiftLedShape = "line",
  sdkRedline?: number | null,
  sdkBlinkRpm?: number | null,
): void {
  const isSvgCircle = shape === "circle";
  const shaped = shape === "circle" || shape === "triangle";

  const apply = (el: HTMLElement, on: boolean, col: string, flash: boolean) => {
    const lit = flash ? "#cfe8ff" : on ? col : OFF_BG;
    if (isSvgCircle) {
      (el as unknown as SVGCircleElement).setAttribute("fill", lit);
    } else {
      el.style.background = lit;
    }
    if (flash) {
      if (shaped) {
        el.style.boxShadow = "none";
        el.style.filter = "drop-shadow(0 0 5px #cfe8ff)";
      } else {
        el.style.filter = "none";
        el.style.boxShadow = "0 0 9px #cfe8ff";
      }
      return;
    }
    if (shaped) {
      el.style.boxShadow = "none";
      el.style.filter = on ? `drop-shadow(0 0 4px ${col})` : "none";
    } else {
      el.style.filter = "none";
      el.style.boxShadow = on ? `0 0 7px ${col}` : "none";
    }
  };

  if (profile) {
    // Real per-car shift lights: each LED has its own RPM threshold (by
    // gear), its own color, and the whole strip flashes at the blink point.
    // SDK blink RPM > SDK redline > Lovely profile gear redline > config fallback.
    const g = gearLeds(profile, gear);
    const blinkThreshold =
      (sdkBlinkRpm ?? 0) > 0 ? sdkBlinkRpm! :
      (sdkRedline ?? 0) > 0 ? sdkRedline! :
      (g?.redline ?? fallbackRedline);
    const blinkMs = profile.blinkIntervalMs || 250;
    const flash = rpm >= blinkThreshold && Math.floor(performance.now() / blinkMs) % 2 === 0;
    for (let i = 0; i < ledCount; i++) {
      const el = ledRefs[i];
      if (!el) continue;
      // Physical gap segments ("#000000" in the community data) are
      // stripped from the profile at load time (see carLeds.ts), so
      // every LED here is real and participates in sweep + flash.
      const col = profile.colors[i] ?? colors.accent;
      const on = g ? rpm >= g.leds[i] : false;
      apply(el, on, col, flash);
    }
    return;
  }

  // Fallback: flat redline, evenly-spaced LEDs, fixed color bands.
  // Prefer SDK redline over the widget config value for gauge scale.
  const gaugeMax = (sdkRedline ?? 0) > 0 ? sdkRedline! : fallbackRedline;
  const rpmPct = Math.max(0, Math.min(1, rpm / gaugeMax));
  const flash = rpmPct > 0.97 && Math.floor(performance.now() / 70) % 2 === 0;
  for (let i = 0; i < ledCount; i++) {
    const el = ledRefs[i];
    if (!el) continue;
    const on = (i + 0.5) / ledCount <= rpmPct;
    const col = i < 6 ? colors.throttle : i < 11 ? colors.loss : colors.accent;
    apply(el, on, col, flash);
  }
}
