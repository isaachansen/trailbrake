import { useRef } from "react";
import { useSlow } from "../store/hooks";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface SectorDeltaConfig {
  precision: "1" | "2" | "3";
  /** Which lap the shown sector deltas are measured against. */
  reference: "personal" | "session";
}

const defaultConfig: SectorDeltaConfig = {
  precision: "2",
  reference: "personal",
};

const SECTOR_KEYS = ["s1", "s2", "s3"] as const;
const BAR_RANGE_S = 1.0;
const CLOSE_THRESHOLD_S = 0.1;
/** Sector deltas beyond this are out-lap / invalid artefacts. */
const MAX_VALID_SECTOR_DELTA_S = 10;
const validDelta = (d: number | null): number | null =>
  d != null && isFinite(d) && Math.abs(d) <= MAX_VALID_SECTOR_DELTA_S ? d : null;

/**
 * How long (ms) a just-completed lap's sector line stays frozen after the
 * start/finish crossing before the new lap's live sectors take over — long
 * enough to read all three sectors plus the lap result before it clears. A
 * pure UI-timing choice (like a CSS transition duration), not a telemetry
 * value, so it's keyed off wall-clock time rather than `currentLapS`.
 */
const HOLD_MS = 4000;

type Reference = SectorDeltaConfig["reference"];
const REFERENCES: Reference[] = ["personal", "session"];

/**
 * Per-reference running state for the lap currently in progress.
 * `baseline[k]` is the reference field's value (`deltaBestS` /
 * `deltaSessionBestS`) at the instant sector k started — since those fields
 * are genuinely live, continuously-interpolated "elapsed-time-so-far vs. the
 * reference lap at the same track position" numbers, `refField(now) -
 * baseline[k]` is an honest, sector-local live delta with no fabrication.
 * `null` means "never legitimately captured" (e.g. the widget mounted
 * mid-sector) and must render as "--", never as a fake near-zero number.
 */
interface ChannelState {
  baseline: (number | null)[];
  values: (number | null)[];
}

function freshChannel(): ChannelState {
  return { baseline: [null, null, null], values: [null, null, null] };
}

interface SectorState {
  lap: number | null;
  filled: number;
  channels: Record<Reference, ChannelState>;
  /** Snapshot of both channels' values taken at the last line crossing, held
   * on screen for `HOLD_MS` so the driver can read S3 + the lap result. */
  banked: Record<Reference, (number | null)[]> | null;
  resetAtMs: number;
  /**
   * Lowest sector index whose *start* we actually witnessed (vs. inferring
   * from an already-completed sector we only discovered on mount). Only a
   * witnessed sector boundary may seed the next sector's baseline — if the
   * widget mounts mid-lap after S1 is already done, we don't know when S2
   * truly started, so seeding S2's baseline from "whatever the reference
   * field reads right now" would anchor it to an arbitrary mount instant
   * instead of S2's real start, quietly understating the live delta. `null`
   * until the first tick or a line crossing establishes it.
   */
  watchedFrom: number | null;
}

function freshState(): SectorState {
  return {
    lap: null,
    filled: 0,
    channels: { personal: freshChannel(), session: freshChannel() },
    banked: null,
    resetAtMs: -Infinity,
    watchedFrom: null,
  };
}

function SectorDelta({ theme, config }: BaseWidgetProps<SectorDeltaConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;
  const precision = Number(config.precision);
  const reference: Reference = config.reference === "session" ? "session" : "personal";

  // Cross-render state machine, mutated directly during render (same
  // ref-mutation-in-render idiom as Relative.tsx's highlight tracking): each
  // tick compares the incoming slow sample against what was recorded last
  // tick, so a React StrictMode double-invoke with the same `slow` object
  // converges to a no-op on its second pass (the ref already matches).
  const stateRef = useRef<SectorState>(freshState());
  const s = stateRef.current;

  let displayValues: (number | null)[] = [null, null, null];
  let activeIdx = -1;

  if (slow == null) {
    // Session ended — honest empty state, matching store.clear() elsewhere.
    stateRef.current = freshState();
  } else {
    const cur = slow.sectorTimesS;
    const best = slow.sectorBestS;
    const refField: Record<Reference, number | null> = {
      personal: slow.deltaBestS,
      session: slow.deltaSessionBestS,
    };

    // Sectors fill front-to-back within a lap; a run of non-null entries
    // from s1 is the count actually completed so far this lap. Using a
    // contiguous run (rather than a raw non-null count) keeps this robust
    // against a stray out-of-order null.
    let filled = 0;
    while (filled < 3 && cur[SECTOR_KEYS[filled]] != null) filled++;
    const curLap = slow.lap;

    const lapChanged = s.lap !== null && curLap !== null && curLap !== s.lap;
    // A regression (sectors filled going down without a lap-number change)
    // covers sims/mocks whose sector reset isn't tied to `lap` ticking over
    // in the same frame (e.g. the mock's demo cycle, or the real connector's
    // S3-then-clear-on-wrap ordering).
    const resetHappened = lapChanged || filled < s.filled;

    if (resetHappened) {
      s.banked = {
        personal: [...s.channels.personal.values],
        session: [...s.channels.session.values],
      };
      s.resetAtMs = performance.now();
      s.channels = { personal: freshChannel(), session: freshChannel() };
      s.filled = 0;
      // Crossing the line is a witnessed, unambiguous sector-1 start.
      s.watchedFrom = 0;
      for (const ref of REFERENCES) s.channels[ref].baseline[0] = refField[ref];
    }

    // Advance any sectors that completed since the last tick.
    for (let k = s.filled; k < filled; k++) {
      const key = SECTOR_KEYS[k];
      const c = cur[key];
      const b = best[key];
      // The exact, non-interpolated split — always preferred for the
      // personal reference when both fields are present.
      const exactPersonal = c != null && b != null ? c - b : null;
      // Only seed the *next* sector's baseline off a completion we actually
      // watched happen — never off a sector that was already done the first
      // time we observed it (see `watchedFrom`'s doc comment).
      const witnessed = s.watchedFrom !== null && k >= s.watchedFrom;
      for (const ref of REFERENCES) {
        const ch = s.channels[ref];
        const baseline = ch.baseline[k];
        const rf = refField[ref];
        const fallback = baseline != null && rf != null ? rf - baseline : null;
        ch.values[k] = ref === "personal" && exactPersonal != null ? exactPersonal : fallback;
        if (k + 1 < 3 && witnessed) ch.baseline[k + 1] = rf;
      }
    }
    s.filled = filled;
    s.lap = curLap;
    // First observation ever (no reset witnessed yet): from this point on we
    // ARE watching continuously, so the sector in progress right now (index
    // `filled`) can validly seed the one after it once it completes.
    if (s.watchedFrom === null) s.watchedFrom = filled;

    // Live-tick the sector currently in progress.
    if (filled < 3) {
      for (const ref of REFERENCES) {
        const ch = s.channels[ref];
        const baseline = ch.baseline[filled];
        const rf = refField[ref];
        ch.values[filled] = baseline != null && rf != null ? rf - baseline : null;
      }
    }

    const holding = s.banked != null && performance.now() - s.resetAtMs < HOLD_MS;
    const liveValues = { personal: s.channels.personal.values, session: s.channels.session.values };
    displayValues = (holding ? s.banked! : liveValues)[reference];
    activeIdx = !holding && filled < 3 ? filled : -1;
  }

  const row = (idx: number) => {
    const key = SECTOR_KEYS[idx];
    const rawDelta = displayValues[idx];
    // Bar and numeric text share one validity-gated value so they never disagree
    // (an out-lap artefact must not render a full bar next to a "--").
    const delta = validDelta(rawDelta);
    const displayDelta = delta;
    const isLive = idx === activeIdx;

    const color = delta == null ? t.textDim : Math.abs(delta) <= CLOSE_THRESHOLD_S ? t.amber : delta < 0 ? t.gain : t.loss;
    const frac = delta == null ? 0 : Math.max(-1, Math.min(1, delta / BAR_RANGE_S));
    const widthPct = Math.abs(frac) * 50;
    const gaining = delta != null && delta < 0;
    const leftPct = gaining ? 50 : 50 - widthPct;

    return (
      <div key={key} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* A subtle border (HighlightedDriver's cell pattern) — the cell fill
            alone (t.cell, 4% white) is too close to the panel color to read
            as a distinct chip even under the brightened theme. The currently
            in-progress sector gets an accent border so the driver can tell
            which row is actively ticking. */}
        <div style={{ fontFamily: theme.font.label, width: "1.9em", textAlign: "center", padding: "3px 0", background: t.cell, border: `1px solid ${isLive ? t.accent : t.surfaceBorder}`, borderRadius: 7, boxSizing: "border-box", fontWeight: 700, fontSize: "0.72em", color: isLive ? t.accent : t.textDim, letterSpacing: "0.06em" }}>
          S{idx + 1}
        </div>
        <span style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.05em", color, width: "3.6em", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {fmtSecDelta(displayDelta, precision)}
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
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden", gap: theme.space.md }}>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center" }}>
        <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.78em", letterSpacing: "0.1em" }}>SECTOR DELTA</span>
      </div>
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
        { value: "personal", label: "Personal Best" },
        { value: "session", label: "Session Best" },
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
