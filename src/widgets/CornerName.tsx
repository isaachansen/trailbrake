import { useEffect, useMemo, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useSlow } from "../store/hooks";
import type { TrackTurnMarker } from "../store/types";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

/** A track section with start/end lap fractions (Lovely) or a point marker fallback. */
interface TrackSection {
  name: string;
  start: number;
  end: number;
}

function inSection(pct: number, start: number, end: number): boolean {
  if (start <= end) return pct >= start && pct < end;
  return pct >= start || pct < end;
}

function sectionProgress(pct: number, start: number, end: number): number {
  let len = end - start;
  if (len <= 0) len += 1;
  let into = pct - start;
  if (into < 0) into += 1;
  return Math.max(0, Math.min(1, into / len));
}

/**
 * Build sections from Lovely turn ranges when available; otherwise derive
 * marker-only segments from turn points on the baked centerline.
 */
function buildSections(
  lovelyTurns: TrackTurnMarker[] | null | undefined,
  trackTurns: { label: string; x: number; y: number }[] | null,
  trackPath: [number, number][] | null,
): TrackSection[] {
  if (lovelyTurns && lovelyTurns.length > 0) {
    const ranged = lovelyTurns.filter(
      (t) => t.start != null && t.end != null && Number.isFinite(t.start) && Number.isFinite(t.end),
    );
    if (ranged.length > 0) {
      return ranged
        .map((t) => ({ name: t.name, start: t.start!, end: t.end! }))
        .sort((a, b) => a.start - b.start);
    }
    const markers = [...lovelyTurns]
      .map((t) => ({ name: t.name, marker: t.marker }))
      .sort((a, b) => a.marker - b.marker);
    return markers.map((m, i) => {
      const next = markers[(i + 1) % markers.length]!.marker;
      return { name: m.name, start: m.marker, end: next <= m.marker ? next + 1 : next };
    });
  }
  if (trackTurns && trackTurns.length > 0 && trackPath && trackPath.length > 0) {
    const n = trackPath.length;
    const markers = trackTurns
      .map((tn) => {
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
      })
      .sort((a, b) => a.marker - b.marker);
    return markers.map((m, i) => {
      const next = markers[(i + 1) % markers.length]!.marker;
      return { name: m.name, start: m.marker, end: next <= m.marker ? next + 1 : next };
    });
  }
  return [];
}

function formatCornerName(raw: string): string {
  const s = raw.trim();
  return /^\d+[a-z]?$/i.test(s) ? `T${s}` : s;
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

  const lovelyTurns = slow?.trackMetadata?.lovelyTurns ?? null;
  const trackTurns = slow?.trackTurns ?? null;
  const trackPath = slow?.trackPath ?? null;
  const sections = useMemo(
    () => buildSections(lovelyTurns, trackTurns, trackPath),
    [lovelyTurns, trackTurns, trackPath],
  );
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const fast = store.latestFast;
      const list = sectionsRef.current.length > 0 ? sectionsRef.current : null;
      const pct = fast?.lapDistPct ?? null;

      let label = "—";
      let sub = "";
      let progress = 0;

      if (list && list.length > 0 && pct != null) {
        const current = list.find((s) => inSection(pct, s.start, s.end));
        if (current) {
          label = formatCornerName(current.name);
          sub = "IN";
          progress = sectionProgress(pct, current.start, current.end);
        } else {
          const next = list.find((s) => {
            let d = s.start - pct;
            if (d < 0) d += 1;
            return d < 0.5;
          }) ?? list[0];
          if (next) {
            label = formatCornerName(next.name);
            sub = "NEXT";
            let segLen = next.start - pct;
            if (segLen < 0) segLen += 1;
            const total = next.end - next.start;
            const norm = total <= 0 ? total + 1 : total;
            progress = Math.max(0, Math.min(1, 1 - segLen / Math.max(norm, 0.01)));
          }
        }
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
