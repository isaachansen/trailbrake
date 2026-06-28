// Spotter: a "car alongside" warning. It can show as a compact widget panel
// (left/right edge bars + a "3 WIDE" cue), as a full-height red glow down the
// left/right edge of the *screen*, or both. The screen glow is portaled into the
// overlay's screen layer (it can't escape the widget's backdrop-filtered box on
// its own); in the manager preview that layer is the preview card, so the glow
// demos itself there.
//
// The widget panel auto-hides: it pops in only while a car is actually alongside
// and disappears otherwise, so it isn't a permanent empty box. The widget owns
// its own panel chrome (the host is transparent for it) so the whole thing — not
// just its contents — can appear/disappear with the signal. (In the manager
// preview the panel always shows so you can see the widget.)
//
// Detection uses proximity data (relLatM/relLonM) when the sim provides it, and
// falls back to the sim's own CarLeftRight spotter signal (carLeft/carRight) when
// it doesn't — so this works on iRacing even though its SDK exposes no lateral
// neighbour offsets. A single rAF loop pokes the bar/edge opacity through refs —
// no React re-render.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStoreInstance } from "../store/storeContext";
import { useScreenLayer } from "../components/screenLayer";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export type SpotterDisplay = "both" | "widget" | "edges";

export interface SpotterConfig {
  /** Longitudinal window (m) within which a neighbour counts as alongside. */
  alongsideM: number;
  /** What to show: the widget panel, the screen-edge glow, or both. */
  display: SpotterDisplay;
}

const defaultConfig: SpotterConfig = { alongsideM: 3, display: "both" };

function Spotter({ theme, config }: BaseWidgetProps<SpotterConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const { el: screenLayer, preview, fullScreen } = useScreenLayer();

  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const wideRef = useRef<HTMLDivElement | null>(null);
  const edgeLeftRef = useRef<HTMLDivElement | null>(null);
  const edgeRightRef = useRef<HTMLDivElement | null>(null);
  // The widget panel auto-hides: it pops in only while a car is alongside. We
  // toggle its opacity/scale from the draw loop (no React re-render), like the
  // bars — so it appears and disappears with the spotter signal.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ config, preview });
  live.current = { config, preview };

  const showWidget = config.display !== "edges";
  const showEdges = config.display !== "widget";

  useEffect(() => {
    let raf = 0;
    const draw = (now: number) => {
      const { config, preview } = live.current;

      // Manager/gallery preview: there's no live "car alongside" to react to, so
      // run a looping demo — a car appears on the RIGHT, then on the LEFT — so the
      // widget bars and/or the screen-edge glow visibly show what the widget does
      // (especially in edges-only mode, where there's no panel to look at).
      if (preview) {
        const period = 2600; // one full right→left cycle (ms)
        const phase = (now % period) / period;
        // Smooth 0→1→0 bump over an active window; the two sides alternate with a
        // short gap between them so it never reads as "3 wide".
        const bump = (s: number, e: number) =>
          phase < s || phase > e ? 0 : Math.sin(((phase - s) / (e - s)) * Math.PI);
        const r = bump(0.04, 0.44);
        const l = bump(0.54, 0.94);
        if (leftRef.current) leftRef.current.style.opacity = (0.12 + 0.88 * l).toFixed(3);
        if (rightRef.current) rightRef.current.style.opacity = (0.12 + 0.88 * r).toFixed(3);
        if (wideRef.current) wideRef.current.style.display = "none";
        if (edgeLeftRef.current) edgeLeftRef.current.style.opacity = (0.95 * l).toFixed(3);
        if (edgeRightRef.current) edgeRightRef.current.style.opacity = (0.95 * r).toFixed(3);
        // Keep the panel visible in preview so the widget is actually shown.
        if (panelRef.current) {
          panelRef.current.style.opacity = "1";
          panelRef.current.style.transform = "scale(1)";
        }
        raf = requestAnimationFrame(draw);
        return;
      }

      const slow = store.getSlow();
      const playerIdx = slow?.playerCarIdx ?? null;
      let warnL = false;
      let warnR = false;

      // Prefer proximity data (relLatM/relLonM) when available — gives precise
      // alongside detection. Otherwise fall back to the sim's CarLeftRight signal.
      let hasProximity = false;
      for (const c of slow?.cars ?? []) {
        if (c.isPlayer || c.carIdx === playerIdx || c.relLatM == null || c.relLonM == null) continue;
        hasProximity = true;
        if (Math.abs(c.relLonM) < config.alongsideM) {
          if (c.relLatM < 0) warnL = true;
          else warnR = true;
        }
      }

      // Fallback: use the sim's own spotter enum when no proximity data exists.
      // This is the path iRacing takes (proximity capability is false, but
      // carLeft/carRight are populated from CarLeftRight). Prefer the fast
      // path (~60 Hz) for near-instant response; fall back to slow only when
      // the fast value is absent (e.g. older backend or pre-session).
      if (!hasProximity) {
        const fast = store.latestFast;
        warnL = fast?.carLeft ?? slow?.carLeft ?? false;
        warnR = fast?.carRight ?? slow?.carRight ?? false;
      }

      if (leftRef.current) leftRef.current.style.opacity = warnL ? "1" : "0.12";
      if (rightRef.current) rightRef.current.style.opacity = warnR ? "1" : "0.12";
      if (wideRef.current) wideRef.current.style.display = warnL && warnR ? "block" : "none";

      // The widget panel only pops up while a car is actually alongside, and
      // disappears otherwise (the screen-edge glow has its own logic below).
      const alongside = warnL || warnR;
      if (panelRef.current) {
        panelRef.current.style.opacity = alongside ? "1" : "0";
        panelRef.current.style.transform = alongside ? "scale(1)" : "scale(0.92)";
      }

      // Screen-edge glow. Pulse it (~2 Hz, 0.72..1.0) when active so it grabs
      // peripheral attention while the driver is focused on the track — a steady
      // fade was too easy to miss mid-corner.
      const pulse = (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(now / 230))).toFixed(3);
      if (edgeLeftRef.current) edgeLeftRef.current.style.opacity = warnL ? pulse : "0";
      if (edgeRightRef.current) edgeRightRef.current.style.opacity = warnR ? pulse : "0";

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  const bar: React.CSSProperties = {
    width: "1.3em",
    // Cap the neighbour bars to door height so the player block stays the focal
    // point — full-height bars read as three equal pillars and flatten hierarchy.
    height: "78%",
    borderRadius: 8,
    background: t.loss,
    opacity: 0.12,
    boxShadow: `0 0 20px ${t.loss}`,
    transition: "opacity 0.08s",
  };

  // Edge glow geometry. On a full "screen" region (live viewport, or the manager
  // preview's screen-sized stage) the fades pin to the left/right edges and fade
  // INWARD — that's the real effect. Only in the isolated gallery (panel-sized
  // layer, no screen around it) do we flank the panel instead: sit just OUTSIDE
  // its edges and fade outward, so the demo reads as a screen effect around the
  // widget rather than being painted across it.
  const flank = preview && !fullScreen;
  const edgeBase: React.CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "14%",
    pointerEvents: "none",
    opacity: 0,
    transition: "opacity 0.08s ease",
  };
  const leftPos: React.CSSProperties = flank ? { right: "100%" } : { left: 0 };
  const rightPos: React.CSSProperties = flank ? { left: "100%" } : { right: 0 };
  // Brighter, 3-stop gradient with a strong near-edge band so it reads clearly in
  // peripheral vision (the old single-stop 0.32 fade was too faint mid-race).
  const leftBg = flank
    ? "linear-gradient(to left, rgba(255,30,46,0.6), rgba(255,30,46,0))"
    : "linear-gradient(to right, rgba(255,30,46,0.72), rgba(255,30,46,0.32) 45%, rgba(255,30,46,0))";
  const rightBg = flank
    ? "linear-gradient(to right, rgba(255,30,46,0.6), rgba(255,30,46,0))"
    : "linear-gradient(to left, rgba(255,30,46,0.72), rgba(255,30,46,0.32) 45%, rgba(255,30,46,0))";

  return (
    <>
      {showWidget && (
        <div
          ref={panelRef}
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            color: t.text,
            padding: theme.space.lg,
            boxSizing: "border-box",
            // The widget owns its panel chrome (the host is transparent for the
            // Spotter) so the whole thing can pop in / out with the signal.
            background: t.surface,
            border: `1px solid ${t.surfaceBorder}`,
            borderRadius: theme.radius,
            backdropFilter: theme.panelBlur,
            WebkitBackdropFilter: theme.panelBlur,
            opacity: 0,
            transform: "scale(0.92)",
            transformOrigin: "center",
            transition: "opacity 0.16s ease, transform 0.16s ease",
          }}
        >
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: theme.space.lg, minHeight: 0 }}>
            <div ref={leftRef} style={bar} />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: theme.space.sm }}>
              <div style={{ width: "2.3em", height: "4.1em", borderRadius: 8, background: t.accent, boxShadow: "0 0 18px rgba(255,45,142,0.55)" }} />
              <div ref={wideRef} style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.7em", letterSpacing: "0.16em", color: t.amber, display: "none" }}>3 WIDE</div>
            </div>
            <div ref={rightRef} style={bar} />
          </div>
          <div style={{ fontFamily: theme.font.label, textAlign: "center", marginTop: theme.space.md, fontWeight: 600, fontSize: "0.58em", letterSpacing: "0.18em", color: t.textDim2 }}>CAR ALONGSIDE</div>
        </div>
      )}

      {showEdges &&
        screenLayer &&
        createPortal(
          <>
            <div ref={edgeLeftRef} style={{ ...edgeBase, ...leftPos, background: leftBg }} />
            <div ref={edgeRightRef} style={{ ...edgeBase, ...rightPos, background: rightBg }} />
          </>,
          screenLayer
        )}
    </>
  );
}

export const spotterDef: WidgetDefinition<SpotterConfig> = {
  id: "spotter",
  name: "Spotter",
  defaultSize: { w: 190, h: 190 },
  minSize: { w: 150, h: 150 },
  defaultConfig,
  requiredPaths: ["slow"],
  // No hard capability requirement — works with either proximity or carLeft/carRight.
  requiredCapabilities: [],
  configSchema: [
    { key: "alongsideM", label: "Alongside (m)", type: "number", min: 1, max: 8, step: 0.5 },
    {
      key: "display",
      label: "Display",
      type: "enum",
      options: [
        { value: "both", label: "Widget + screen edges" },
        { value: "widget", label: "Widget only" },
        { value: "edges", label: "Screen edges only" },
      ],
    },
  ],
  // The host never draws a panel for the Spotter: in edges-only mode there's no
  // panel at all, and in widget/both mode the widget draws its own auto-hiding
  // panel (it pops in only when a car is alongside), so it must own the chrome.
  transparentPanel: () => true,
  Component: Spotter,
};
