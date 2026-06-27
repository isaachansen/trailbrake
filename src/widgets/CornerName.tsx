import { useEffect, useMemo, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSlow } from "../store/hooks";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

/** A corner with a name and a lap-distance fraction (0..1). */
interface CornerMarker {
  name: string;
  marker: number;
}

/**
 * Build the sorted corner list for the current track, preferring real
 * lovely-track-data markers and otherwise deriving lap fractions from the
 * Track Map's `trackTurns` (x,y) against `trackPath`.
 *
 * On real iRacing tracks `trackMetadata` (and thus `lovelyTurns`) is null, but
 * `trackTurns` + `trackPath` ARE present. For each turn we find the nearest
 * point on `trackPath` to the turn's (x,y); that point's index / path.length is
 * the corner's lap fraction (the path is sampled start/finish-first in driving
 * order, so index ↔ lapDistPct).
 */
function buildCorners(
  lovelyTurns: { name: string; marker: number }[] | null | undefined,
  trackTurns: { label: string; x: number; y: number }[] | null,
  trackPath: [number, number][] | null,
): CornerMarker[] {
  if (lovelyTurns && lovelyTurns.length > 0) {
    return [...lovelyTurns]
      .map((tn) => ({ name: tn.name, marker: tn.marker }))
      .sort((a, b) => a.marker - b.marker);
  }
  if (trackTurns && trackTurns.length > 0 && trackPath && trackPath.length > 0) {
    const n = trackPath.length;
    const derived: CornerMarker[] = trackTurns.map((tn) => {
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = trackPath[i][0] - tn.x;
        const dy = trackPath[i][1] - tn.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      return { name: tn.label, marker: bestI / n };
    });
    return derived.sort((a, b) => a.marker - b.marker);
  }
  return [];
}

export interface CornerNameConfig {
  fontSize: "small" | "medium" | "large";
  showProgress: boolean;
}

const defaultConfig: CornerNameConfig = {
  fontSize: "large",
  showProgress: true,
};

const FONT_PX: Record<string, number> = { small: 16, medium: 22, large: 30 };

function CornerName({ theme, config }: BaseWidgetProps<CornerNameConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const slow = useSlow();
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const subRef = useRef<HTMLSpanElement | null>(null);
  const progRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ config });
  live.current = { config };

  // Derive the sorted corner list, preferring real lovely markers and otherwise
  // mapping `trackTurns` (x,y) to lap fractions via the nearest `trackPath`
  // point. Memoized on geometry identity so the nearest-point search doesn't run
  // every rAF frame (it only recomputes when the track/turn data changes).
  const lovelyTurns = slow?.trackMetadata?.lovelyTurns ?? null;
  const trackTurns = slow?.trackTurns ?? null;
  const trackPath = slow?.trackPath ?? null;
  const corners = useMemo(
    () => buildCorners(lovelyTurns, trackTurns, trackPath),
    [lovelyTurns, trackTurns, trackPath],
  );
  const cornersRef = useRef(corners);
  cornersRef.current = corners;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const fast = store.latestFast;
      // Sorted corners (markers are lap-distance fractions 0..1, directly
      // comparable to lapDistPct).
      const turns = cornersRef.current.length > 0 ? cornersRef.current : null;
      const pct = fast?.lapDistPct ?? null;

      let label = "—";
      let sub = "";
      let progress = 0;

      if (turns && turns.length > 0 && pct != null) {
        // Find the last corner whose marker the driver has passed (current corner).
        // We walk the sorted list and find the largest marker <= pct, with wrap-around
        // so that a driver past the last corner (near lap end) wraps to the final corner.
        let currentIdx = turns.length - 1; // default: last corner (lap wrap case)
        for (let i = 0; i < turns.length; i++) {
          if (turns[i].marker > pct) {
            // First corner ahead — the one before it is the current corner.
            currentIdx = i === 0 ? turns.length - 1 : i - 1;
            break;
          }
          // If we exhaust the loop pct >= all markers → currentIdx stays at last corner.
        }

        const nextIdx = (currentIdx + 1) % turns.length;
        const currentMarker = turns[currentIdx].marker;
        const nextMarker = turns[nextIdx].marker;

        // Segment length (circular).
        let segLen = nextMarker - currentMarker;
        if (segLen <= 0) segLen += 1;

        // How far into the current segment the driver is (circular).
        let into = pct - currentMarker;
        if (into < 0) into += 1;

        progress = Math.max(0, Math.min(1, into / segLen));

        // Numeric names ("1", "6a") get a "T" prefix; named corners are verbatim.
        const raw = turns[currentIdx].name.trim();
        label = /^\d+[a-z]?$/i.test(raw) ? `T${raw}` : raw;
        // Sub-label: 1-based ordinal of the current corner in the sorted list.
        sub = `CORNER ${currentIdx + 1}`;
      }

      if (labelRef.current) labelRef.current.textContent = label;
      if (subRef.current) subRef.current.textContent = sub;
      if (progRef.current) progRef.current.style.width = `${progress * 100}%`;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  const fontPx = FONT_PX[config.fontSize] ?? 30;
  const eyebrowPx = Math.round(fontPx * 0.34);

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: theme.space.xs, color: t.text, boxSizing: "border-box", padding: `${theme.space.sm}px ${theme.space.lg}px` }}>
      <span
        ref={subRef}
        style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: eyebrowPx, letterSpacing: "0.18em", color: t.textDim, lineHeight: 1, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        —
      </span>
      <span
        ref={labelRef}
        style={{ fontFamily: theme.font.mono, fontWeight: 800, fontSize: fontPx, color: t.text, lineHeight: 1, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        —
      </span>
      {config.showProgress && (
        <div style={{ width: "76%", height: 3, borderRadius: 2, background: t.gridLine, overflow: "hidden", marginTop: theme.space.xs }}>
          <div ref={progRef} style={{ height: "100%", width: "0%", background: t.accent, borderRadius: 2, transition: "width 0.1s linear" }} />
        </div>
      )}
    </div>
  );
}

export const cornerNameDef: WidgetDefinition<CornerNameConfig> = {
  id: "corner-name",
  name: "Corner Name",
  defaultSize: { w: 300, h: 76 },
  minSize: { w: 200, h: 64 },
  defaultConfig,
  requiredPaths: ["slow", "fast"],
  requiredCapabilities: ["trackMap"],
  configSchema: [
    { key: "fontSize", label: "Font size", type: "enum", options: [{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }] },
    { key: "showProgress", label: "Progress bar", type: "boolean" },
  ],
  Component: CornerName,
};
