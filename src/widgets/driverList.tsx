// Shared driver-list building blocks for Relative + Standings — same trough,
// slot plates, dividers, row metrics, and animated row shell so both widgets
// lock to one visual language. Column content stays per-widget.

import { useEffect, useState, type CSSProperties, type ReactNode, type TransitionEvent } from "react";
import { hexToRgba } from "./format";
import type { Theme } from "../theme/theme";

/** Default (comfortable) row slot height in em. */
export const DRIVER_ROW_H = 2.55;
/** Compact row slot height in em (Standings compact mode). */
export const DRIVER_ROW_H_COMPACT = 2.15;
/** Flush left — position chip sits on the panel edge. */
export const DRIVER_ROW_PAD_L = "0";
/** Trailing inset so the last column isn't glued to the edge. */
export const DRIVER_ROW_PAD_R = "1.2em";
/** Column gap inside a driver row. */
export const DRIVER_COL_GAP = "0.45em";

export const DRIVER_SLIDE_MS = 180;
export const DRIVER_ENTER_MS = 240;
export const DRIVER_EXIT_MS = 240;
export const DRIVER_FLASH_MS = 900;

export function driverRowPad(): string {
  return `0 ${DRIVER_ROW_PAD_R} 0 ${DRIVER_ROW_PAD_L}`;
}

/** Sunken groove between every slot (including empty ones). */
export function SlotDivider({ topEm }: { topEm: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: `${topEm}em`,
        height: 0,
        zIndex: 3,
        pointerEvents: "none",
        borderTop: "1px solid rgba(0, 0, 0, 0.72)",
        boxShadow: "0 1px 0 rgba(255, 255, 255, 0.07)",
      }}
    />
  );
}

/** Recessed plate under each slot so vacant seats still read as a trough. */
export function EmptySlotPlate({ slot, rowH }: { slot: number; rowH: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: `${slot * rowH}em`,
        height: `${rowH}em`,
        zIndex: 0,
        background: "rgba(0, 0, 0, 0.28)",
        boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.035), inset 0 -1px 0 rgba(0, 0, 0, 0.35)",
      }}
    />
  );
}

/** Sunken list body — plates + dividers + absolute-positioned row children. */
export function DriverListTrough({
  slots,
  rowH,
  children,
}: {
  slots: number;
  rowH: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        height: slots ? `${slots * rowH}em` : 0,
        background: "rgba(0, 0, 0, 0.2)",
        boxShadow: "inset 0 2px 6px rgba(0, 0, 0, 0.45)",
      }}
    >
      {Array.from({ length: slots }, (_, i) => (
        <EmptySlotPlate key={`slot-${i}`} slot={i} rowH={rowH} />
      ))}
      {Array.from({ length: Math.max(0, slots - 1) }, (_, i) => (
        <SlotDivider key={`div-${i}`} topEm={(i + 1) * rowH} />
      ))}
      {children}
    </div>
  );
}

/** Brief gain/loss tint overlay for a row that just changed position. */
export function PositionFlash({ eventId, color }: { eventId: number; color: string }) {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    setFaded(false);
    const raf = requestAnimationFrame(() => setFaded(true));
    return () => cancelAnimationFrame(raf);
  }, [eventId]);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 0,
        pointerEvents: "none",
        background: color,
        opacity: faded ? 0 : 1,
        transition: faded ? `opacity ${DRIVER_FLASH_MS}ms ease-out` : "none",
      }}
    />
  );
}

export interface DriverRowShellProps {
  slot: number;
  rowH: number;
  isPlayer: boolean;
  exiting: boolean;
  /** Steady opacity when not entering/exiting (e.g. pit dim). */
  steadyOpacity?: number;
  gridTemplateColumns: string;
  colGap?: string;
  pad?: string;
  accent: string;
  slideMs?: number;
  children: ReactNode;
  onExited: () => void;
  style?: CSSProperties;
}

/** Absolute-positioned animated row frame — player accent, slide + enter/exit. */
export function DriverRowShell({
  slot,
  rowH,
  isPlayer,
  exiting,
  steadyOpacity = 1,
  gridTemplateColumns,
  colGap = DRIVER_COL_GAP,
  pad = driverRowPad(),
  accent,
  slideMs = DRIVER_SLIDE_MS,
  children,
  onExited,
  style,
}: DriverRowShellProps) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const opacity = exiting || !entered ? 0 : steadyOpacity;

  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (exiting && e.propertyName === "opacity") onExited();
  };

  return (
    <div
      onTransitionEnd={onTransitionEnd}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: `${slot * rowH}em`,
        height: `${rowH}em`,
        zIndex: 1,
        display: "grid",
        gridTemplateColumns,
        alignItems: "center",
        gap: colGap,
        padding: pad,
        borderRadius: 0,
        boxSizing: "border-box",
        background: isPlayer ? hexToRgba(accent, 0.32) : "transparent",
        color: isPlayer ? "#fff" : undefined,
        fontWeight: isPlayer ? 800 : 500,
        opacity,
        transition: `top ${slideMs}ms cubic-bezier(.4,0,.2,1), opacity ${exiting ? DRIVER_EXIT_MS : DRIVER_ENTER_MS}ms ease-out, background 0.2s`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Shared gain/loss flash color helper. */
export function flashColor(kind: "gain" | "loss", t: Theme["colors"]): string {
  return hexToRgba(kind === "gain" ? t.gain : t.loss, 0.32);
}
