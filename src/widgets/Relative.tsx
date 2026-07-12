// Relative: the cars immediately around you by track-time, ahead and behind, with
// flag, license, iRating, tyre and the relative gap. Slow-path widget.
//
// Two things make it readable at a glance:
//  - a fixed slot grid (N ahead + you + M behind) keeps the player locked in the
//    middle; missing neighbours leave empty slots so the layout never jumps;
//  - rows are absolutely positioned by slot and transition their `top`, so when an
//    overtake changes the order the two cars visibly slide past each other.
//
// Above and below the rows sit optional header / footer info panels: separate
// floating chrome (not attached to the driver list), with a gap between sections.
// Empty header/footer panels are omitted entirely.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { fmtGap, fmtLapTime, fmtDelta, fuelValue, fuelLabel, tempValue, tempLabel, formatDriverName, type UnitSystem, type DriverNameFormat } from "./format";
import { InfoIcon } from "./relativeInfoIcons";
import { parseLicense } from "./raceColors";
import { FlagSwatch } from "./FlagSwatch";
import { LicenseBadge } from "./LicenseBadge";
import { PosChip } from "./PosChip";
import { TyreBadge } from "./TyreBadge";
import { PitBadge } from "./PitBadge";
import { CarIcon, carIconFor, iracingIcon } from "./carIcons";
import type { CarEntry, SlowSample } from "../store/types";
import { buildProvisionalPositions, relativePosOf } from "./provisionalPos";
import { classifySessionType } from "./contract";
import type { BaseWidgetProps, InfoFieldConfig, SessionType, WidgetDefinition } from "./contract";
import type { Theme } from "../theme/theme";
import { GlassSpecular, panelChrome } from "../components/liquidGlass";
import {
  DRIVER_COL_GAP,
  DRIVER_ROW_H,
  DRIVER_ROW_PAD_R,
  DriverListTrough,
  DriverRowShell,
  PositionFlash,
  flashColor,
} from "./driverList";

export interface RelativeConfig {
  /** How many cars ahead of the player to show. */
  rowsAhead: number;
  /** How many cars behind the player to show. */
  rowsBehind: number;
  /** Multiplier for header/footer info-chip size (independent of row scale). */
  fieldScale: number;
  /** Multiplier for car-row height and typography (independent of field scale). */
  rowScale: number;
  showFlag: boolean;
  showLicense: boolean;
  showIrating: boolean;
  showTyre: boolean;
  showCarIcon: boolean;
  /** In qualifying, show only the player (you're on a solo hot lap — no field). */
  soloInQualy: boolean;
  /** Driver name style: full "First Last" or abbreviated "F. Last". */
  nameFormat: DriverNameFormat;
  /** Info fields shown above the rows (ordered, per-session-type). */
  header: InfoFieldConfig[];
  /** Info fields shown below the rows (ordered, per-session-type). */
  footer: InfoFieldConfig[];
}

// --- info-field catalog -----------------------------------------------------
// Each catalog entry knows its label and how to pull a compact value out of the
// slow sample. `render` returns null when the sim doesn't provide the datum, so
// the chip is simply omitted (never faked — see the data-model conventions).

interface InfoFieldDef {
  key: string;
  label: string;
  render: (slow: SlowSample | null, units: UnitSystem) => string | null;
}

/** Seconds → "h:mm:ss" or "m:ss"; null/non-finite → null. */
function fmtClock(s: number | null | undefined): string | null {
  if (s == null || !isFinite(s) || s < 0) return null;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "current / total" laps. Total is exact when the race is lap-limited; in a
 *  timed race it's estimated from time-left ÷ lap-time and prefixed with ~. */
function lapsValue(s: SlowSample | null): string | null {
  if (s?.lap == null) return null;
  const cur = s.lap;
  if (s.lapsRemaining != null) return `${cur} / ${cur + s.lapsRemaining}`;
  const lapT = s.lastLapS ?? s.bestLapS;
  if (s.timeRemainingS != null && lapT != null && lapT > 0) {
    return `${cur} / ~${cur + Math.ceil(s.timeRemainingS / lapT)}`;
  }
  return `${cur} / --`;
}

const INFO_FIELDS: InfoFieldDef[] = [
  { key: "sessionType", label: "Session", render: (s) => (s?.sessionType ? (classifySessionType(s.sessionType) ?? s.sessionType).toUpperCase() : null) },
  { key: "track", label: "Track", render: (s) => s?.trackName ?? null },
  { key: "position", label: "Pos", render: (s) => (s?.position != null ? `P${s.position}` : null) },
  { key: "classPosition", label: "Class", render: (s) => (s?.classPosition != null ? `P${s.classPosition}` : null) },
  { key: "timeLeft", label: "Time", render: (s) => fmtClock(s?.timeRemainingS) },
  { key: "lapsLeft", label: "Laps", render: (s) => lapsValue(s) },
  { key: "lap", label: "Lap", render: (s) => (s?.lap != null ? `${s.lap}` : null) },
  { key: "last", label: "Last", render: (s) => (s?.lastLapS != null ? fmtLapTime(s.lastLapS) : null) },
  { key: "best", label: "Best", render: (s) => (s?.bestLapS != null ? fmtLapTime(s.bestLapS) : null) },
  { key: "deltaBest", label: "Δ best", render: (s) => (s?.deltaBestS != null ? fmtDelta(s.deltaBestS) : null) },
  { key: "deltaSess", label: "Δ sess", render: (s) => (s?.deltaSessionBestS != null ? fmtDelta(s.deltaSessionBestS) : null) },
  { key: "fuel", label: "Fuel", render: (s, u) => (s?.fuelL != null ? `${fuelValue(s.fuelL, u)!.toFixed(1)}${fuelLabel(u)}` : null) },
  { key: "fuelPerLap", label: "Fuel/lap", render: (s, u) => (s?.fuelPerLapL != null ? `${fuelValue(s.fuelPerLapL, u)!.toFixed(2)}${fuelLabel(u)}` : null) },
  // Conditions (icons in the design; data-backed fields only — never faked).
  { key: "airTemp", label: "Air temp", render: (s, u) => { const v = tempValue(s?.airTempC ?? null, u); return v != null ? `${Math.round(v)}${tempLabel(u)}` : null; } },
  { key: "trackTemp", label: "Track temp", render: (s, u) => { const v = tempValue(s?.trackTempC ?? null, u); return v != null ? `${Math.round(v)}${tempLabel(u)}` : null; } },
  { key: "brakeBias", label: "Brake bias", render: (s) => (s?.brakeBiasPct != null ? `${(s.brakeBiasPct * 100).toFixed(1)}%` : null) },
  {
    key: "incidents",
    label: "Incidents",
    render: (s) => {
      if (s?.incidents == null) return null;
      const limit = s.incidentLimit != null ? String(s.incidentLimit) : "∞";
      return `${s.incidents}/${limit}`;
    },
  },
];

/** Catalog exposed to the settings panel (key + label, in default order). */
export const RELATIVE_INFO_CATALOG = INFO_FIELDS.map((f) => ({ key: f.key, label: f.label }));
const FIELD_MAP: Record<string, InfoFieldDef> = Object.fromEntries(INFO_FIELDS.map((f) => [f.key, f]));
const ALL_SESSIONS: SessionType[] = ["race", "qualy", "practice"];

/** Build a default field list: the given keys on, the rest off, all sessions. */
function buildFieldDefaults(onKeys: string[]): InfoFieldConfig[] {
  return INFO_FIELDS.map((f) => ({ key: f.key, on: onKeys.includes(f.key), sessions: [...ALL_SESSIONS] }));
}

const defaultConfig: RelativeConfig = {
  rowsAhead: 3,
  rowsBehind: 3,
  fieldScale: 1.15,
  rowScale: 1,
  showFlag: true,
  showLicense: true,
  showIrating: true,
  showTyre: true,
  showCarIcon: true,
  soloInQualy: true,
  nameFormat: "full",
  header: buildFieldDefaults(["sessionType", "position", "timeLeft", "incidents"]),
  footer: buildFieldDefaults(["last", "best", "fuel"]),
};

const ROWH = DRIVER_ROW_H; // em — slot height; rows animate their `top` between slots.
const SLIDE_MS = 180; // position-swap glide — keep under the ~200ms slow tick so rows don't lag live order
/** Gap between the disconnected header / main / footer panels (design px). */
const SECTION_GAP = 8;
/** InfoBar type size (em) before the user `fieldScale` multiplier. */
const INFO_BAR_EM = 1.05;

/** The chips to show for one info bar, given the current session category. */
function visibleChips(entries: InfoFieldConfig[] | undefined, slow: SlowSample | null, cur: SessionType | null, units: UnitSystem) {
  return (entries ?? [])
    .filter((e) => e.on && (cur == null || e.sessions.includes(cur)))
    .map((e) => ({ def: FIELD_MAP[e.key], value: FIELD_MAP[e.key]?.render(slow, units) ?? null }))
    .filter((x): x is { def: InfoFieldDef; value: string } => x.def != null && x.value != null);
}

function InfoBar({ chips, color, dim, mono, scale }: { chips: { def: InfoFieldDef; value: string }[]; color: string; dim: string; mono: string; scale: number }) {
  if (chips.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.55em 1.15em",
        fontSize: `${INFO_BAR_EM * scale}em`,
      }}
    >
      {chips.map(({ def, value }) => (
        <span key={def.key} title={def.label} style={{ display: "inline-flex", alignItems: "center", gap: "0.5em", whiteSpace: "nowrap" }}>
          <span style={{ color: dim, display: "inline-flex", opacity: 0.95 }}>
            <InfoIcon name={def.key} size="1.15em" strokeWidth={2} />
          </span>
          <span
            style={{
              color,
              fontFamily: mono,
              fontWeight: 800,
              fontSize: "1.08em",
              letterSpacing: "0.01em",
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
            }}
          >
            {value}
          </span>
        </span>
      ))}
    </div>
  );
}

// --- position-change animation -----------------------------------------
// Rows are keyed by stable car identity (`carIdx`), never by list position, so
// an overtake reorders `top` on the same DOM node instead of remounting it —
// that's what lets the CSS transition below actually play as a slide instead
// of a teleport. `RelativeRowState` is a superset of the currently-visible
// cars: a car that drops out of the window lingers with `exiting: true` so it
// can fade out instead of vanishing.

interface RelativeRowState {
  carIdx: number;
  slot: number;
  exiting: boolean;
}

interface HighlightEvent {
  id: number;
  kind: "gain" | "loss";
}

/** Reconcile the previous row list against this tick's visible slots: existing
 *  cars get their new slot (or get marked `exiting` once they drop out), and
 *  newly-visible cars are appended. Returns `prev` unchanged (same reference)
 *  when nothing moved, so callers can skip the state update entirely.
 *
 *  `capacity` caps the total row count at what the box actually measures as
 *  fitting (`fit`, from the size-aware layout above): a lingering exit fade
 *  is a real extra DOM row, and if the box has no spare room for it, letting
 *  it through would inflate the widget's measured content height and trip
 *  `FitContent`'s shrink-to-fit — the *whole widget* visibly shrinking mid-
 *  swap, which is worse than the exit just popping. This only bites when a
 *  car leaves the window at the same moment another enters it elsewhere
 *  (e.g. the player's own rank change slides the whole ahead/behind slice by
 *  one) — the common case of just two rows trading places never touches it,
 *  since neither row ever leaves `visible`. */
function deriveRelativeRows(prev: RelativeRowState[], visibleIdx: Map<number, number>, capacity: number): RelativeRowState[] {
  let changed = false;
  const next: RelativeRowState[] = [];
  const seen = new Set<number>();
  for (const r of prev) {
    seen.add(r.carIdx);
    const slot = visibleIdx.get(r.carIdx);
    if (slot != null) {
      if (r.exiting || r.slot !== slot) changed = true;
      next.push({ carIdx: r.carIdx, slot, exiting: false });
    } else if (r.exiting) {
      next.push(r); // already fading out — leave it be until it removes itself
    } else {
      changed = true;
      next.push({ ...r, exiting: true }); // just dropped out of the window
    }
  }
  for (const [carIdx, slot] of visibleIdx) {
    if (!seen.has(carIdx)) {
      changed = true;
      next.push({ carIdx, slot, exiting: false });
    }
  }
  if (next.length > Math.max(capacity, visibleIdx.size)) {
    changed = true;
    let overflow = next.length - Math.max(capacity, visibleIdx.size);
    return next.filter((r) => {
      if (overflow > 0 && r.exiting) {
        overflow--;
        return false; // drop the fade — capacity is tight, pop it instead
      }
      return true;
    });
  }
  return changed ? next : prev;
}

interface RelativeRowProps {
  car: CarEntry;
  slot: number;
  rowH: number;
  exiting: boolean;
  isPlayer: boolean;
  pos: number | null;
  provisional: boolean;
  gap: number;
  inPit: boolean;
  lic: { letter: string; sr: string } | null;
  t: Theme["colors"];
  mono: string;
  has: { flag: boolean; car: boolean; lic: boolean; ir: boolean; tyre: boolean; lapTrend: boolean };
  cols: string;
  nameFormat: DriverNameFormat;
  highlight: HighlightEvent | null;
  onExited: (carIdx: number) => void;
}

/** One relative row — shared DriverRowShell + widget-specific columns. */
function RelativeRow({ car, slot, rowH, exiting, isPlayer, pos, provisional, gap, inPit, lic, t, mono, has, cols, nameFormat, highlight, onExited }: RelativeRowProps) {
  return (
    <DriverRowShell
      slot={slot}
      rowH={rowH}
      isPlayer={isPlayer}
      exiting={exiting}
      steadyOpacity={inPit && !isPlayer ? 0.7 : 1}
      gridTemplateColumns={cols}
      accent={t.accent}
      slideMs={SLIDE_MS}
      onExited={() => onExited(car.carIdx)}
      style={{ color: isPlayer ? "#fff" : t.textDim }}
    >
      {highlight && <PositionFlash eventId={highlight.id} color={flashColor(highlight.kind, t)} />}
      {pos == null ? (
        <span style={{ color: t.textDim2 }}>--</span>
      ) : (
        <PosChip pos={pos} provisional={provisional} isPlayer={isPlayer} t={t} rowH={rowH} />
      )}
      {has.car && (
        <span style={{ justifySelf: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {(() => {
            const ic = carIconFor(car.carScreenName) ?? iracingIcon;
            return <CarIcon src={ic} color={isPlayer ? "#fff" : t.text} size="1.5em" />;
          })()}
        </span>
      )}
      {has.flag && (
        <span style={{ justifySelf: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <FlagSwatch country={car.country} />
        </span>
      )}
      <span style={{ display: "flex", alignItems: "center", alignSelf: "stretch", gap: "0.75em", overflow: "hidden", minWidth: 0, lineHeight: 1 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, lineHeight: 1, color: isPlayer ? "#fff" : t.text }}>
          {formatDriverName(car.driverName, nameFormat, `Car ${car.carIdx}`)}
        </span>
        {inPit && <PitBadge color={t.amber} />}
      </span>
      {has.lic && (
        <span style={{ justifySelf: "start", alignSelf: "stretch", display: "flex", alignItems: "center" }}>
          {lic && <LicenseBadge letter={lic.letter} sr={lic.sr} />}
        </span>
      )}
      {has.ir && (
        <span style={{ fontFamily: mono, fontVariantNumeric: "tabular-nums", textAlign: "right", color: t.textDim }}>
          {car.irating != null ? (car.irating / 1000).toFixed(1) + "k" : "--"}
        </span>
      )}
      {has.tyre && (
        <span style={{ justifySelf: "center", alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <TyreBadge compound={car.tyre} />
        </span>
      )}
      <span style={{ fontFamily: mono, fontWeight: 700, fontVariantNumeric: "tabular-nums", textAlign: "right", color: isPlayer ? "#fff" : gap > 0 ? t.loss : t.gain }}>
        {isPlayer ? "—" : `${gap > 0 ? "+" : "−"}${fmtGap(gap)}`}
      </span>
      {has.lapTrend && (
        <span style={{ fontFamily: mono, fontVariantNumeric: "tabular-nums", textAlign: "right", fontSize: "0.88em", color: car.lapDeltaVsAvgS == null ? t.textDim2 : (car.lapDeltaVsAvgS < -0.05 ? t.gain : car.lapDeltaVsAvgS > 0.05 ? t.loss : t.textDim) }}>
          {car.lapDeltaVsAvgS != null ? fmtDelta(car.lapDeltaVsAvgS) : "—"}
        </span>
      )}
    </DriverRowShell>
  );
}

function Relative({ theme, config, panelOpacity = 1 }: BaseWidgetProps<RelativeConfig>) {
  const t = theme.colors;
  const mono = theme.font.mono;
  const slow = useSlow();
  const playerIdx = slow?.playerCarIdx ?? null;
  const curSession = classifySessionType(slow?.sessionType);
  // In qualifying you run a solo hot lap, so the field is just noise — show only
  // the player when `soloInQualy` is on.
  const soloQualy = config.soloInQualy && curSession === "qualy";
  const cars = (slow?.cars ?? []).filter((c) => !soloQualy || c.isPlayer || c.carIdx === playerIdx);
  const { units, panelStyle } = useSettings();
  const glass = panelStyle === "liquid";
  const chrome = panelChrome(theme, glass, panelOpacity);

  // Provisional grid position. Before anyone sets a time (practice / pre-qualify)
  // iRacing reports no running position, so the badge would otherwise read "--".
  // iRacing seeds the starting order by iRating, so we reproduce that: rank the
  // field by iRating (descending), both overall and within class, and use it only
  // as a fallback — a real position from the sim always wins once it exists.
  const { provPos, provClassPos } = useMemo(() => buildProvisionalPositions(slow?.cars ?? []), [slow?.cars]);

  /** A car's shown position: real (class, then overall) first, else the iRating
   *  provisional. Returns the number and whether it's provisional. */
  const posOf = (c: CarEntry) => relativePosOf(c, provPos, provClassPos);

  // Surface the player's provisional position in the header/footer info chips too,
  // so "Pos"/"Class" show the iRating-seeded number pre-qualify instead of nothing.
  const slowForChips = useMemo(() => {
    if (!slow || playerIdx == null) return slow;
    if (slow.position != null && slow.classPosition != null) return slow;
    return {
      ...slow,
      position: slow.position ?? provPos.get(playerIdx) ?? null,
      classPosition: slow.classPosition ?? provClassPos.get(playerIdx) ?? null,
    };
  }, [slow, playerIdx, provPos, provClassPos]);

  const headerChips = visibleChips(config.header, slowForChips, curSession, units);
  const footerChips = visibleChips(config.footer, slowForChips, curSession, units);
  const fieldScale = config.fieldScale > 0 ? config.fieldScale : 1;
  const rowScale = config.rowScale > 0 ? config.rowScale : 1;
  const rowH = ROWH * rowScale;

  // Sort by relative gap (ahead → behind), keeping only cars with a known gap.
  // Drop cars that aren't in the world (`inWorld === false`): during practice the
  // roster includes drivers sitting in their garage, whose stale track-time gives
  // them a phantom gap that would otherwise drop them onto the relative. The
  // player is always kept regardless.
  const ordered = cars
    .filter(
      (c) =>
        c.isPlayer ||
        c.carIdx === playerIdx ||
        (c.inWorld !== false && c.gapToPlayerS != null)
    )
    .sort((a, b) => (b.gapToPlayerS ?? 0) - (a.gapToPlayerS ?? 0));

  const playerAt = ordered.findIndex((c) => c.isPlayer || c.carIdx === playerIdx);

  // Fixed slot grid from settings — height is clamped to this content budget
  // (`clampHeightToContent`), so we never drop ahead/behind seats to "fit" a
  // short box (that was causing 3+3 → 2+3 with empty bands above/below).
  const ahead = Math.max(0, config.rowsAhead);
  const behind = Math.max(0, config.rowsBehind);
  const slotCount = ahead + behind + 1;
  const slots: (CarEntry | null)[] = Array(slotCount).fill(null);
  if (playerAt >= 0) {
    slots[ahead] = ordered[playerAt];
    const aheadCars = ordered.slice(Math.max(0, playerAt - ahead), playerAt);
    for (let i = 0; i < aheadCars.length; i++) {
      // Fewer than N ahead → pad empties at the top; nearest sits just above you.
      slots[ahead - aheadCars.length + i] = aheadCars[i];
    }
    const behindCars = ordered.slice(playerAt + 1, playerAt + 1 + behind);
    for (let i = 0; i < behindCars.length; i++) {
      slots[ahead + 1 + i] = behindCars[i];
    }
  } else {
    // No player in the ordered list — just fill from the top.
    for (let i = 0; i < Math.min(ordered.length, slotCount); i++) slots[i] = ordered[i];
  }
  const visible = slots.filter((c): c is CarEntry => c != null);

  // Row list for the slide animation: a superset of `visible` that keeps a
  // just-departed car around (fading out) until its exit transition finishes.
  // Gated on `visSig` (not `visible` itself, which is a fresh array every
  // render) so this only fires when membership/order actually changes.
  const [rows, setRows] = useState<RelativeRowState[]>([]);
  // Include empty-slot markers so a car sliding into a previously-empty slot
  // (or vacating one) always retriggers, even when the set of carIdxs is unchanged.
  const visSig = slots.map((c) => (c ? c.carIdx : "-")).join(",");
  // useLayoutEffect so slot assignments land before paint — useEffect left rows
  // one frame behind fresh gap data, which reads as cars ahead showing below you.
  useLayoutEffect(() => {
    const visibleIdx = new Map<number, number>();
    slots.forEach((c, slot) => {
      if (c) visibleIdx.set(c.carIdx, slot);
    });
    setRows((prev) => deriveRelativeRows(prev, visibleIdx, slotCount));
    // `slots` is intentionally omitted — `visSig` already encodes membership + slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visSig, slotCount]);

  const handleExited = useCallback((carIdx: number) => {
    setRows((prev) => prev.filter((r) => r.carIdx !== carIdx));
  }, []);

  // Latest known data per car, so an exiting row (no longer in `visible`) keeps
  // rendering its last known state through the fade instead of going blank.
  const carDataRef = useRef<Map<number, CarEntry>>(new Map());
  // Keep the full ordered field fresh, not just the trimmed window — exiting rows
  // and mid-swap slides should never show stale gaps from an old slice.
  ordered.forEach((c) => carDataRef.current.set(c.carIdx, c));

  // Gain/loss flash: a flash means the user actually *witnessed* a swap, so it
  // only fires for a pairwise inversion between two cars that are BOTH visible
  // right now and were BOTH visible (and ranked) last tick — i.e. two rows the
  // user could see trade places on screen. This is deliberately narrower than
  // "rank changed in the unwindowed order": that alone can't tell a real
  // visible swap from a car joining/leaving `ordered` (tow, gap going null)
  // shifting every index below it, or an off-screen swap between cars outside
  // the window. Rank is still taken from the unwindowed `ordered` list (so the
  // *direction* of a swap is correct even if the window trims differently),
  // but the swap only lights up when both participants are in `visible`.
  //
  // Requiring both cars in the *previous* visible set too (not just ranked)
  // means a car sliding into the window while passing someone already visible
  // won't flash the newcomer (it wasn't on screen a moment ago to be "seen"
  // arriving) — the visible car it passed also won't flash since its partner
  // in the inversion wasn't previously visible. This trades a rare legitimate
  // case for a strong guarantee against phantom flashes on window churn.
  const rankRef = useRef<Map<number, number>>(new Map());
  const prevVisibleRef = useRef<Set<number>>(new Set());
  const highlightsRef = useRef<Map<number, HighlightEvent>>(new Map());
  const hlIdRef = useRef(0);
  {
    const rankMap = new Map(ordered.map((c, i) => [c.carIdx, i]));
    const prevRanks = rankRef.current;
    const prevVisible = prevVisibleRef.current;
    const curVisible = new Set(visible.map((c) => c.carIdx));
    // Only cars that were visible last tick AND are visible this tick AND had
    // a known rank both times are eligible to participate in a witnessed swap.
    const eligible = visible.filter((c) => prevVisible.has(c.carIdx) && prevRanks.has(c.carIdx));
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i];
        const b = eligible[j];
        const prevA = prevRanks.get(a.carIdx)!;
        const prevB = prevRanks.get(b.carIdx)!;
        const curA = rankMap.get(a.carIdx)!;
        const curB = rankMap.get(b.carIdx)!;
        const wasAhead = prevA - prevB;
        const isAhead = curA - curB;
        if (wasAhead === 0 || isAhead === 0) continue; // shouldn't happen (ranks unique) but guard anyway
        if (Math.sign(wasAhead) === Math.sign(isAhead)) continue; // no inversion
        hlIdRef.current += 1;
        const gainer = curA < curB ? a : b;
        const loser = gainer === a ? b : a;
        highlightsRef.current.set(gainer.carIdx, { id: hlIdRef.current, kind: "gain" });
        hlIdRef.current += 1;
        highlightsRef.current.set(loser.carIdx, { id: hlIdRef.current, kind: "loss" });
      }
    }
    // Expire: prune any highlight whose car isn't visible right now, so a car
    // that scrolls out of the window and later scrolls back in can never
    // replay a stale event (the bug this whole rewrite fixes). A highlight
    // for a car that stays visible the whole time is harmless to leave in
    // place — `PositionFlash` keys its fade effect on `event.id`, so once it
    // has faded to transparent it stays that way until a *new* id (a fresh
    // witnessed swap) arrives; it never re-plays on its own.
    for (const carIdx of highlightsRef.current.keys()) {
      if (!curVisible.has(carIdx)) highlightsRef.current.delete(carIdx);
    }
    rankRef.current = rankMap;
    prevVisibleRef.current = curVisible;
  }

  const has = {
    flag: config.showFlag && visible.some((c) => c.country),
    car: config.showCarIcon && visible.some((c) => carIconFor(c.carScreenName)),
    lic: config.showLicense && visible.some((c) => c.safetyRating),
    ir: config.showIrating && visible.some((c) => c.irating != null),
    tyre: config.showTyre && visible.some((c) => c.tyre),
    lapTrend: visible.some((c) => c.lapDeltaVsAvgS != null),
  };

  // Grid columns mirror the data we actually have.
  const cols =
    "2.85em" + // pos
    (has.car ? " 2em" : "") + // car icon
    (has.flag ? " 1.3em" : "") + // flag, just before the name
    " minmax(3em,1fr)" + // name
    (has.lic ? " 4.2em" : "") +
    (has.ir ? " 2.7em" : "") +
    (has.tyre ? " 2em" : "") +
    " 3.1em" + // gap
    (has.lapTrend ? " 2.4em" : ""); // lap form vs rolling avg

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: SECTION_GAP,
        color: t.text,
        boxSizing: "border-box",
      }}
    >
      {headerChips.length > 0 && (
        <div style={{ ...chrome, flex: "none", padding: theme.widgetPad, boxSizing: "border-box" }}>
          {glass && <GlassSpecular />}
          <div style={{ position: "relative", zIndex: 1 }}>
            <InfoBar chips={headerChips} color={t.text} dim={t.textDim} mono={mono} scale={fieldScale} />
          </div>
        </div>
      )}

      {/* Main driver list — own panel, always present. Rows are flush to the
          panel edges (no outer pad); empty slots keep recessed plates + sunken
          dividers so the grid reads even when neighbours are missing. */}
      <div
        style={{
          ...chrome,
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          padding: 0,
          boxSizing: "border-box",
          // Square corners so flush rows don't leave rounded empty gutters.
          borderRadius: theme.radius,
          overflow: "hidden",
        }}
      >
        {glass && <GlassSpecular />}
        <div style={{ position: "relative", zIndex: 1, flex: "0 0 auto" }}>
          {ordered.length === 0 ? (
            <div style={{ textAlign: "center", color: t.textDim, fontSize: "0.82em", padding: theme.widgetPad }}>No field data</div>
          ) : (
            <DriverListTrough slots={slotCount} rowH={rowH}>
              {rows.map((r) => {
                const car = carDataRef.current.get(r.carIdx);
                if (!car) return null;
                const isPlayer = car.isPlayer || car.carIdx === playerIdx;
                const gap = car.gapToPlayerS ?? 0;
                const inPit = car.onPitRoad === true;
                const lic = parseLicense(car.safetyRating);
                const { pos, provisional } = posOf(car);
                const highlight = highlightsRef.current.get(r.carIdx) ?? null;
                return (
                  <RelativeRow
                    key={r.carIdx}
                    car={car}
                    slot={r.slot}
                    rowH={rowH}
                    exiting={r.exiting}
                    isPlayer={isPlayer}
                    pos={pos}
                    provisional={provisional}
                    gap={gap}
                    inPit={inPit}
                    lic={lic}
                    t={t}
                    mono={mono}
                    has={has}
                    cols={cols}
                    nameFormat={config.nameFormat === "short" ? "short" : "full"}
                    highlight={highlight}
                    onExited={handleExited}
                  />
                );
              })}
            </DriverListTrough>
          )}
        </div>
      </div>

      {footerChips.length > 0 && (
        <div style={{ ...chrome, flex: "none", padding: theme.widgetPad, boxSizing: "border-box" }}>
          {glass && <GlassSpecular />}
          <div style={{ position: "relative", zIndex: 1 }}>
            <InfoBar chips={footerChips} color={t.text} dim={t.textDim} mono={mono} scale={fieldScale} />
          </div>
        </div>
      )}
    </div>
  );
}

// Narrowest box (design px, scale 1) that fits the columns the given config
// enables, so the row grid never overflows/clips. The em-widths mirror the
// `cols` template built in <Relative> above; rows render at the 14px base, so
// EM = 14.
function relativeMinWidth(config: RelativeConfig): number {
  const EM = 14;
  const colEms = [2.85]; // pos
  if (config.showCarIcon) colEms.push(2);
  if (config.showFlag) colEms.push(1.3);
  colEms.push(3); // driver name (minmax(3em,…) lower bound)
  if (config.showLicense) colEms.push(4.2);
  if (config.showIrating) colEms.push(2.7);
  if (config.showTyre) colEms.push(2);
  colEms.push(3.1); // gap
  const sumEm = colEms.reduce((a, b) => a + b, 0) + parseFloat(DRIVER_COL_GAP) * (colEms.length - 1) + parseFloat(DRIVER_ROW_PAD_R);
  return Math.ceil(sumEm * EM);
}

/** Design-px height (@ scale 1) for the configured ahead/behind grid + chrome.
 *  Changing drivers-ahead/behind (or row scale) resizes the instance on Y via
 *  the host's contentHeight delta — so the box tracks the locked slot count.
 *
 *  Must leave the main list's *clientHeight* ≥ `rows × ROWH × EM` after header,
 *  footer, section gaps, and each panel's 1px borders — otherwise FitContent
 *  scales the whole widget down to compensate.
 */
function relativeContentHeight(config: RelativeConfig): number {
  const EM = 14;
  const rowScale = config.rowScale > 0 ? config.rowScale : 1;
  const fieldScale = config.fieldScale > 0 ? config.fieldScale : 1;
  const rows = Math.max(1, config.rowsAhead + config.rowsBehind + 1);
  const padY = 16; // theme.widgetPad top+bottom (8px × 2)
  // InfoBar line (INFO_BAR_EM × value scale) + icon metrics; ceil so we don't undershoot.
  const chipContent = Math.ceil(INFO_BAR_EM * 1.35 * fieldScale * EM);
  const panelBorderY = 2; // 1px top + bottom on each chrome panel (border-box)
  const rowBlock = Math.ceil(rows * ROWH * rowScale * EM);
  const hasHeader = (config.header ?? []).some((e) => e.on);
  const hasFooter = (config.footer ?? []).some((e) => e.on);
  const headerH = hasHeader ? padY + chipContent + panelBorderY : 0;
  const footerH = hasFooter ? padY + chipContent + panelBorderY : 0;
  // Main border-box must be rowBlock + borders so clientHeight ≥ rowBlock.
  const mainH = rowBlock + panelBorderY;
  const gaps = (hasHeader ? SECTION_GAP : 0) + (hasFooter ? SECTION_GAP : 0);
  return headerH + mainH + footerH + gaps;
}

export const relativeDef: WidgetDefinition<RelativeConfig> = {
  id: "relative",
  name: "Relative",
  // Wide enough that at full scale (1.0, readable text) the fixed-width columns
  // (pos/flag/icon/license/iR/tyre/gap) don't crowd out the driver-name column's
  // `1fr` — see the note above `relativeMinWidth` for the em budget.
  defaultSize: { w: 640, h: relativeContentHeight(defaultConfig) },
  minSize: { w: 280, h: 80 },
  minContentWidth: relativeMinWidth,
  contentHeight: relativeContentHeight,
  // Extra height past the configured ahead/behind slots is empty — lock the box
  // height to the content-driven size (min == max) so resize can't stretch or
  // starve the slot grid.
  clampHeightToContent: true,
  // Host stays transparent so header / main / footer can be separate floating
  // panels with visible gaps between them (each section paints its own chrome).
  transparentPanel: () => true,
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [
    { key: "rowsAhead", label: "Drivers ahead", type: "number", min: 0, max: 12, step: 1 },
    { key: "rowsBehind", label: "Drivers behind", type: "number", min: 0, max: 12, step: 1 },
    { key: "fieldScale", label: "Field scale", type: "number", min: 0.6, max: 2, step: 0.05 },
    { key: "rowScale", label: "Row scale", type: "number", min: 0.6, max: 2, step: 0.05 },
    { key: "showFlag", label: "Flags", type: "boolean" },
    { key: "showLicense", label: "License", type: "boolean" },
    { key: "showIrating", label: "iRating", type: "boolean" },
    { key: "showTyre", label: "Tyre", type: "boolean" },
    { key: "showCarIcon", label: "Car icon", type: "boolean" },
    { key: "soloInQualy", label: "Solo in qualy", type: "boolean" },
    {
      key: "nameFormat",
      label: "Driver names",
      type: "enum",
      options: [
        { value: "full", label: "First Last" },
        { value: "short", label: "F. Last" },
      ],
    },
    { key: "header", label: "Header", type: "fieldList", fields: RELATIVE_INFO_CATALOG },
    { key: "footer", label: "Footer", type: "fieldList", fields: RELATIVE_INFO_CATALOG },
  ],
  Component: Relative,
};
