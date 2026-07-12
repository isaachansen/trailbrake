import { useSlow } from "../store/hooks";
import type { Sectors, SlowSample } from "../store/types";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import { sectorColorKey, sectorColorKeyFromDelta, sectorThemeColor } from "./sectorColors";

export interface SectorDeltaConfig {
  precision: "1" | "2" | "3";
  /** Which lap the shown sector deltas are measured against. */
  reference: "personal" | "session" | "ghost";
}

const defaultConfig: SectorDeltaConfig = {
  precision: "2",
  reference: "ghost",
};

const SECTOR_KEYS = ["s1", "s2", "s3"] as const;
type SectorKey = (typeof SECTOR_KEYS)[number];
const BAR_RANGE_S = 1.0;
/** Sector deltas beyond this are out-lap / invalid artefacts. */
const MAX_VALID_SECTOR_DELTA_S = 10;
const validDelta = (d: number | null): number | null =>
  d != null && isFinite(d) && Math.abs(d) <= MAX_VALID_SECTOR_DELTA_S ? d : null;

type Reference = SectorDeltaConfig["reference"];

function hasAnySector(s: Sectors): boolean {
  return s.s1 != null || s.s2 != null || s.s3 != null;
}

/** Ghost with automatic fallthrough when ghost splits are missing. */
function resolveReference(requested: Reference, slow: SlowSample): Reference {
  if (requested !== "ghost") return requested;
  if (hasAnySector(slow.sectorGhostBestS)) return "ghost";
  if (hasAnySector(slow.sectorSessionBestS)) return "session";
  return "personal";
}

function pick(s: Sectors, key: SectorKey): number | null {
  return s[key];
}

/**
 * Live in-sector delta vs a fixed sector split: compare elapsed time in the
 * sector to `refTime * progress` (linear pace through the sector). Negative =
 * ahead of the reference split.
 */
function liveDeltaVsSplit(elapsed: number | null, progress: number | null, refTime: number | null): number | null {
  if (elapsed == null || progress == null || refTime == null || !(refTime > 0)) return null;
  if (!(progress >= 0) || !isFinite(elapsed) || !isFinite(progress)) return null;
  return elapsed - refTime * progress;
}

/**
 * Fallback elapsed when the connector didn't publish `sectorElapsedS` (e.g. an
 * older replay): current lap time minus completed sector splits this lap.
 */
function derivedElapsed(slow: SlowSample, activeIdx: number): number | null {
  if (slow.currentLapS == null || !(slow.currentLapS >= 0)) return null;
  let sum = 0;
  for (let i = 0; i < activeIdx; i++) {
    const t = pick(slow.sectorTimesS, SECTOR_KEYS[i]);
    if (t == null) return null;
    sum += t;
  }
  const e = slow.currentLapS - sum;
  return e >= 0 && e < 600 ? e : null;
}

/** Fallback 0..1 progress from player lap distance when `sectorProgress` is absent. */
function derivedProgress(slow: SlowSample, activeIdx: number): number | null {
  const player = slow.cars.find((c) => c.isPlayer) ?? (slow.playerCarIdx != null ? slow.cars.find((c) => c.carIdx === slow.playerCarIdx) : undefined);
  const pct = player?.lapDistPct;
  if (pct == null || !isFinite(pct)) return null;
  const meta = slow.trackMetadata?.sectors ?? [];
  const starts =
    meta.length >= 2 ? [0, ...meta.slice(1).map((s) => s.marker), 1] : [0, 1 / 3, 2 / 3, 1];
  const start = starts[activeIdx] ?? activeIdx / 3;
  const end = starts[activeIdx + 1] ?? (activeIdx + 1) / 3;
  const span = end - start;
  if (!(span > 1e-6)) return null;
  return Math.min(1, Math.max(0, (pct - start) / span));
}

function SectorDelta({ theme, config }: BaseWidgetProps<SectorDeltaConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;
  const precision = Number(config.precision);
  const requested: Reference =
    config.reference === "session" ? "session" : config.reference === "personal" ? "personal" : "ghost";

  const mode = slow != null ? resolveReference(requested, slow) : requested;
  const activeIdx =
    slow?.currentSectorIdx != null && slow.currentSectorIdx >= 0 && slow.currentSectorIdx < 3
      ? slow.currentSectorIdx
      : -1;

  const row = (idx: number) => {
    const key = SECTOR_KEYS[idx];
    const isLive = idx === activeIdx;

    if (slow == null) {
      return (
        <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: theme.font.label, width: "1.9em", textAlign: "center", padding: "3px 0", background: t.cell, border: `1px solid ${t.surfaceBorder}`, borderRadius: 7, boxSizing: "border-box", fontWeight: 700, fontSize: "0.72em", color: t.textDim, letterSpacing: "0.06em" }}>
            S{idx + 1}
          </div>
          <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color: t.textDim, width: "3.6em", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            --
          </span>
          <div style={{ position: "relative", flex: 1, height: "0.9em", borderRadius: "0.45em", background: "rgba(255,255,255,0.07)", overflow: "hidden" }} />
        </div>
      );
    }

    const cur = pick(slow.sectorTimesS, key);
    const prev = pick(slow.sectorPrevTimesS, key);
    // Current sector: previous-lap split is the static fallback. Completed:
    // this lap's split, else previous.
    const displayTime = isLive ? prev : (cur ?? prev);
    const showingPrevFallback = isLive || (cur == null && prev != null);

    const personalRef = pick(slow.sectorBestS, key);
    const sessionBest = pick(slow.sectorSessionBestS, key);
    const sessionBestPrev = pick(slow.sectorSessionBestPrevS, key);
    const ghostRef = pick(slow.sectorGhostBestS, key);

    // Split used for live pace + completed delta (session falls back to personal
    // when per-sector session bests aren't in the feed yet — e.g. old replay).
    const splitRef =
      mode === "ghost" ? ghostRef : mode === "session" ? (sessionBest ?? personalRef) : personalRef;

    let rawDelta: number | null = null;
    let dimmed = false;

    if (isLive) {
      const elapsed = slow.sectorElapsedS ?? derivedElapsed(slow, activeIdx);
      const progress = slow.sectorProgress ?? derivedProgress(slow, activeIdx);
      // Ghost: prefer profile-interpolated live delta when the connector has a
      // reference lap. Session/personal: always elapsed vs split×progress so the
      // chosen reference actually drives the number.
      if (mode === "ghost" && slow.sectorLiveDeltaS != null) {
        rawDelta = slow.sectorLiveDeltaS;
      } else {
        rawDelta = liveDeltaVsSplit(elapsed, progress, splitRef);
      }
      if (rawDelta == null && displayTime != null && splitRef != null) {
        rawDelta = displayTime - splitRef;
        dimmed = true;
      }
    } else if (displayTime != null && splitRef != null) {
      // Purple session improvement: delta vs the prior session best.
      const deltaRef =
        mode === "session" &&
        sessionBest != null &&
        displayTime <= sessionBest &&
        sessionBestPrev != null
          ? sessionBestPrev
          : splitRef;
      rawDelta = displayTime - deltaRef;
      dimmed = showingPrevFallback;
    }

    const delta = validDelta(rawDelta);
    const colorKey =
      isLive && delta != null
        ? sectorColorKeyFromDelta(delta, splitRef)
        : sectorColorKey(displayTime, splitRef);
    const color = sectorThemeColor(t, colorKey);
    const textColor = delta == null ? t.textDim : color;
    const frac = delta == null ? 0 : Math.max(-1, Math.min(1, delta / BAR_RANGE_S));
    const widthPct = Math.abs(frac) * 50;
    const gaining = delta != null && delta < 0;
    const leftPct = gaining ? 50 : 50 - widthPct;

    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontFamily: theme.font.label, width: "1.9em", textAlign: "center", padding: "3px 0", background: t.cell, border: `1px solid ${isLive ? t.accent : t.surfaceBorder}`, borderRadius: 7, boxSizing: "border-box", fontWeight: 700, fontSize: "0.72em", color: isLive ? t.accent : t.textDim, letterSpacing: "0.06em" }}>
          S{idx + 1}
        </div>
        <span
          style={{
            fontFamily: mono,
            fontWeight: 700,
            fontSize: "1.05em",
            color: textColor,
            width: "3.6em",
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            opacity: dimmed ? 0.7 : 1,
          }}
        >
          {fmtSecDelta(delta, precision)}
        </span>
        <div style={{ position: "relative", flex: 1, height: "0.9em", borderRadius: "0.45em", background: "rgba(255,255,255,0.07)", overflow: "hidden", isolation: "isolate" }}>
          <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, background: "rgba(255,255,255,0.4)", transform: "translateX(-50%)" }} />
          <div
            style={{
              position: "absolute",
              top: 2,
              bottom: 2,
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              background: color,
              borderRadius: gaining ? "0 0.35em 0.35em 0" : "0.35em 0 0 0.35em",
              transition: "left 0.12s linear, width 0.12s linear",
              transform: "translateZ(0)",
              backfaceVisibility: "hidden",
              opacity: dimmed ? 0.7 : 1,
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden", gap: theme.space.md }}>
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", justifyContent: "center", gap: theme.space.md, minHeight: 0 }}>
        {SECTOR_KEYS.map((_, i) => row(i))}
      </div>
    </div>
  );
}

export const sectorDeltaDef: WidgetDefinition<SectorDeltaConfig> = {
  id: "sector-delta",
  name: "Sector Delta",
  defaultSize: { w: 240, h: 140 },
  minSize: { w: 180, h: 100 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["sectors"],
  configSchema: [
    {
      key: "reference",
      label: "Reference Lap",
      type: "enum",
      options: [
        { value: "ghost", label: "Reference Lap" },
        { value: "session", label: "Session Best" },
        { value: "personal", label: "Personal Best" },
      ],
    },
    {
      key: "precision",
      label: "Decimals",
      type: "enum",
      options: [
        { value: "1", label: "1" },
        { value: "2", label: "2" },
        { value: "3", label: "3" },
      ],
    },
  ],
  Component: SectorDelta,
};

function fmtSecDelta(s: number | null | undefined, precision: number): string {
  if (s == null || !isFinite(s)) return "--";
  return `${s >= 0 ? "+" : ""}${s.toFixed(precision)}`;
}
