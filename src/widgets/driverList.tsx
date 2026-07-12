// Shared driver-list building blocks — metrics from Theme.list so packs restyle
// Relative, Standings, and future timing-tower widgets together.

import { useEffect, useState, type CSSProperties, type ReactNode, type TransitionEvent } from "react";
import { hexToRgba } from "./format";
import type { Theme } from "../theme/theme";

export const DRIVER_SLIDE_MS = 180;
export const DRIVER_ENTER_MS = 240;
export const DRIVER_EXIT_MS = 240;
export const DRIVER_FLASH_MS = 900;

export function driverRowPad(theme: Theme): string {
  const L = theme.list;
  return `0 ${L.padR} 0 ${L.padL}`;
}

/** Sunken groove between every slot (including empty ones). */
export function SlotDivider({ topEm, theme }: { topEm: number; theme: Theme }) {
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
        borderTop: theme.list.divider,
        boxShadow: theme.list.dividerGlow,
      }}
    />
  );
}

/** Recessed plate under each slot so vacant seats still read as a trough. */
export function EmptySlotPlate({ slot, rowH, theme }: { slot: number; rowH: number; theme: Theme }) {
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
        background: theme.list.plate,
        boxShadow: theme.list.plateShadow,
      }}
    />
  );
}

/** Sunken list body — plates + dividers + absolute-positioned row children. */
export function DriverListTrough({
  slots,
  rowH,
  theme,
  children,
}: {
  slots: number;
  rowH: number;
  theme: Theme;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        height: slots ? `${slots * rowH}em` : 0,
        background: theme.list.trough,
        boxShadow: theme.list.troughShadow,
      }}
    >
      {Array.from({ length: slots }, (_, i) => (
        <EmptySlotPlate key={`slot-${i}`} slot={i} rowH={rowH} theme={theme} />
      ))}
      {Array.from({ length: Math.max(0, slots - 1) }, (_, i) => (
        <SlotDivider key={`div-${i}`} topEm={(i + 1) * rowH} theme={theme} />
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
  steadyOpacity?: number;
  gridTemplateColumns: string;
  theme: Theme;
  colGap?: string;
  pad?: string;
  slideMs?: number;
  children: ReactNode;
  onExited: () => void;
  style?: CSSProperties;
}

/** Absolute-positioned animated row frame — player accent from theme. */
export function DriverRowShell({
  slot,
  rowH,
  isPlayer,
  exiting,
  steadyOpacity = 1,
  gridTemplateColumns,
  theme,
  colGap,
  pad,
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

  const L = theme.list;
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
        gap: colGap ?? L.colGap,
        padding: pad ?? driverRowPad(theme),
        borderRadius: 0,
        boxSizing: "border-box",
        background: isPlayer ? hexToRgba(theme.colors.accent, L.playerFillAlpha) : "transparent",
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

export function flashColor(kind: "gain" | "loss", t: Theme["colors"]): string {
  return hexToRgba(kind === "gain" ? t.gain : t.loss, 0.32);
}
