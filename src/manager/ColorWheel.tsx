// An in-app HSV color wheel for picking a custom accent color, replacing the
// OS-native color dialog. Hue is the angle around the wheel, saturation the
// distance from the center; a separate slider sets brightness (value). Renders
// as a popover that reports the chosen `#rrggbb` via `onChange` as you drag.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const SIZE = 176; // wheel diameter (px)
const R = SIZE / 2;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function hsvToHex(h: number, s: number, v: number): string {
  return "#" + hsvToRgb(h, s, v).map((n) => n.toString(16).padStart(2, "0")).join("");
}

interface Hsv { h: number; s: number; v: number }

function hexToHsv(hex: string): Hsv {
  let h = (hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(num)) return { h: 330, s: 0.82, v: 1 }; // fallback (pink)
  const r = ((num >> 16) & 255) / 255, g = ((num >> 8) & 255) / 255, b = (num & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { h: hue, s: max ? d / max : 0, v: max };
}

export function ColorWheel({
  value,
  onChange,
  onClose,
  anchorEl,
}: {
  value: string;
  onChange: (hex: string) => void;
  onClose: () => void;
  /** When set, the popover portals to `document.body` and positions itself
   *  with `position: fixed` off this element's rect — so it can't be clipped
   *  by an ancestor scroll container (e.g. the widget-config modal). Falls
   *  back to the plain absolutely-positioned popover when omitted. */
  anchorEl?: HTMLElement | null;
}) {
  // Hue/value are kept in local state because they can't be recovered from the
  // hex once a color is gray or black (sat/value collapse the hue). External
  // changes (clicking a preset) re-sync below.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
  const popRef = useRef<HTMLDivElement | null>(null);
  const wheelRef = useRef<HTMLDivElement | null>(null);

  // Fixed-position coordinates when anchored (portal mode). Null until the
  // first measurement lands, so the very first paint doesn't flash at 0,0.
  const [fixedPos, setFixedPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchorEl) {
      setFixedPos(null);
      return;
    }
    const reposition = () => {
      const r = anchorEl.getBoundingClientRect();
      const margin = 10;
      const popW = popRef.current?.offsetWidth ?? SIZE + 28;
      const popH = popRef.current?.offsetHeight ?? SIZE + 120;
      let top = r.bottom + margin;
      // Flip above the trigger if the popover would run off the bottom of the
      // viewport (e.g. opened near the foot of a scrolling modal).
      if (top + popH > window.innerHeight - 8) top = Math.max(8, r.top - margin - popH);
      let left = r.left;
      if (left + popW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - popW);
      setFixedPos({ top, left });
    };
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchorEl]);

  // Local draft string for the hex text field. Typing doesn't route straight
  // through `hsv`/`onChange` (a controlled value snaps back on every
  // intermediate keystroke, e.g. clearing the field to type "3399ff" makes it
  // unusable) — it only syncs from `hex` while the field isn't focused.
  const [hexDraft, setHexDraft] = useState(hex.toUpperCase());
  const [hexInvalid, setHexInvalid] = useState(false);
  const hexFocused = useRef(false);

  const parseHex = (v: string): string | null => {
    const t = v.trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(t)) return null;
    return (t.startsWith("#") ? t : `#${t}`).toLowerCase();
  };

  // Re-sync when the accent is changed from outside this picker (e.g. a preset,
  // or a wheel/brightness drag) — but never while the user is mid-edit in the
  // hex field, or their in-progress keystrokes would be clobbered.
  useEffect(() => {
    if (value.toLowerCase() !== hex.toLowerCase()) setHsv(hexToHsv(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    if (!hexFocused.current) {
      setHexDraft(hex.toUpperCase());
      setHexInvalid(false);
    }
  }, [hex]);

  // Close on a click outside the popover. Ignore the trigger swatch itself so its
  // own click handles the toggle (otherwise this closes and the toggle reopens).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (popRef.current && !popRef.current.contains(target) && !target?.closest?.("[data-accent-trigger]")) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  const set = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  };

  const pickFromWheel = (e: React.PointerEvent) => {
    const el = wheelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    const s = clamp(Math.hypot(x, y) / (rect.width / 2), 0, 1);
    const h = (Math.atan2(x, -y) * 180) / Math.PI;
    set({ h: (h + 360) % 360, s, v: hsv.v });
  };

  const dragging = useRef(false);
  const onWheelDown = (e: React.PointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    pickFromWheel(e);
  };
  const onWheelMove = (e: React.PointerEvent) => {
    if (dragging.current) pickFromWheel(e);
  };
  const endDrag = (e: React.PointerEvent) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // Thumb position: hue = angle (0 at top, clockwise), saturation = radius.
  const rad = (hsv.h * Math.PI) / 180;
  const thumbX = R + hsv.s * R * Math.sin(rad);
  const thumbY = R - hsv.s * R * Math.cos(rad);

  const fullColor = hsvToHex(hsv.h, hsv.s, 1); // value=1, for the brightness track

  const popStyle: CSSProperties | undefined = anchorEl
    ? {
        position: "fixed",
        top: fixedPos?.top ?? -9999,
        left: fixedPos?.left ?? -9999,
        // Avoid a one-frame flash at the fallback coordinates before the first
        // real measurement lands.
        visibility: fixedPos ? "visible" : "hidden",
      }
    : undefined;

  const pop = (
    <div className="cw-pop" ref={popRef} style={popStyle}>
      <div
        ref={wheelRef}
        className="cw-wheel"
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={onWheelDown}
        onPointerMove={onWheelMove}
        onPointerUp={endDrag}
      >
        {/* Dim the displayed wheel toward the chosen brightness so the preview matches. */}
        <div className="cw-wheel-dim" style={{ opacity: 1 - hsv.v }} />
        <div className="cw-thumb" style={{ left: thumbX, top: thumbY, background: hex }} />
      </div>

      <label className="cw-value" style={{ "--track": `linear-gradient(to right, #000, ${fullColor})` } as CSSProperties}>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(hsv.v * 100)}
          onChange={(e) => set({ ...hsv, v: Number(e.target.value) / 100 })}
          aria-label="Brightness"
        />
      </label>

      <div className="cw-foot">
        <span className="cw-preview" style={{ background: hex }} />
        <input
          className={`cw-hex${hexInvalid ? " invalid" : ""}`}
          value={hexDraft}
          spellCheck={false}
          aria-invalid={hexInvalid || undefined}
          onFocus={() => {
            hexFocused.current = true;
          }}
          onChange={(e) => {
            const v = e.target.value;
            setHexDraft(v);
            const norm = parseHex(v);
            if (norm) {
              // A keystroke just completed a valid hex — commit live, same as
              // dragging the wheel, without forcing the field back to `#RRGGBB`
              // shape while the user may still be typing.
              setHsv(hexToHsv(norm));
              onChange(norm);
              setHexInvalid(false);
            } else {
              setHexInvalid(v.trim().length > 0);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              setHexDraft(hex.toUpperCase());
              setHexInvalid(false);
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            hexFocused.current = false;
            const norm = parseHex(e.target.value);
            if (norm) {
              setHsv(hexToHsv(norm));
              onChange(norm);
              setHexDraft(norm.toUpperCase());
            } else {
              // Invalid on blur — revert to the last committed color rather than
              // leaving garbage in the field.
              setHexDraft(hex.toUpperCase());
            }
            setHexInvalid(false);
          }}
        />
      </div>
    </div>
  );

  return anchorEl ? createPortal(pop, document.body) : pop;
}
