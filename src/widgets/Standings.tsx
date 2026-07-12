// Standings: rich, optionally multi-class grouped field — position change, car
// number, country flag, driver, license badge, iRating (+delta), gap-to-best-lap,
// last/best lap, tyre compound. Slow-path widget.
//
// Columns are built dynamically and a column is dropped entirely when no car can
// fill it, so a sim that doesn't expose (say) tyre or flag data degrades cleanly.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSlow, useCaps } from "../store/hooks";
import { fmtLapTime, fmtDelta, formatDriverName, type DriverNameFormat } from "./format";
import { parseLicense, classColorMap, classColorOf } from "./raceColors";
import { FlagSwatch } from "./FlagSwatch";
import { LicenseBadge } from "./LicenseBadge";
import { PosChip } from "./PosChip";
import { TyreBadge } from "./TyreBadge";
import { PitBadge } from "./PitBadge";
import { CarIcon, carIconFor, iracingIcon } from "./carIcons";
import type { CarEntry } from "../store/types";
import { buildProvisionalPositions, standingPosOf, standingSortKey } from "./provisionalPos";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import { defaultTheme, type Theme } from "../theme/theme";
import {
  DriverListTrough,
  DriverRowShell,
  PositionFlash,
  flashColor,
  driverRowPad,
} from "./driverList";

export interface StandingsConfig {
  maxRows: number;
  myClassOnly: boolean;
  /** Tighter rows + type — more drivers in the same box. */
  compact: boolean;
  showLastLap: boolean;
  showBest: boolean;
  showIrating: boolean;
  showFlag: boolean;
  showLicense: boolean;
  showTyre: boolean;
  showCarIcon: boolean;
  /** Driver name style: full "First Last" or abbreviated "F. Last". */
  nameFormat: DriverNameFormat;
}

const defaultConfig: StandingsConfig = {
  maxRows: 16,
  myClassOnly: false,
  compact: false,
  showLastLap: true,
  showBest: true,
  showIrating: true,
  showFlag: true,
  showLicense: true,
  showTyre: true,
  showCarIcon: true,
  nameFormat: "full",
};

/** Row / type metrics — row height/pad from the active theme's list tokens. */
function standingsDensity(compact: boolean, list: Theme["list"]) {
  return compact
    ? {
        rowH: list.rowHCompact,
        rowGapPx: 0,
        font: 0.95,
        carIcon: "1.55em",
        padL: list.padL,
        padR: list.padR,
      }
    : {
        rowH: list.rowH,
        rowGapPx: 0,
        font: 1.08,
        carIcon: "1.7em",
        padL: list.padL,
        padR: list.padR,
      };
}

type StandingsDensity = ReturnType<typeof standingsDensity>;

/** Average iRating across rated cars — matches iRacing's Strength of Field. */
function strengthOfField(cars: CarEntry[]): number | null {
  const rated = cars.map((c) => c.irating).filter((v): v is number => v != null);
  if (rated.length === 0) return null;
  return Math.round(rated.reduce((a, b) => a + b, 0) / rated.length);
}

function SofValue({ value, theme, mono, t }: { value: number; theme: Theme; mono: string; t: Theme["colors"] }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, fontSize: "0.82em" }}>
      <span style={{ fontFamily: theme.font.label, letterSpacing: "0.06em", fontWeight: 700, color: t.textDim }}>SOF</span>
      <span style={{ fontFamily: mono, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: t.text }}>{value}</span>
    </span>
  );
}

/** Exact pixel height of the standings body for the rows currently on screen. */
function standingsContentHeightPx(
  groups: { id: number | null; name: string | null; display: RowCtx[] }[],
  rowsByGroup: Map<string, StandingsRowState[]>,
  fontPx: number,
  multiclass: boolean,
  showSofBar: boolean,
  density: StandingsDensity,
): number {
  const rowH = density.rowH * fontPx + density.rowGapPx;
  const colH = 1.7 * fontPx;
  // Meta / column headers sit above the flush trough; no outer root pad.
  let h = 4;
  for (const g of groups) {
    if (multiclass && g.name) h += 1.35 * fontPx + 8;
    else if (showSofBar) h += 1.2 * fontPx + 6;
    h += colH;
    const key = String(g.id ?? "all");
    const animRows = rowsByGroup.get(key) ?? [];
    h += Math.max(g.display.length, animRows.length) * rowH;
  }
  return h;
}

interface RowCtx {
  car: CarEntry;
  pos: number | null;
  /** How much slower this car's best lap is vs class/session best (seconds). */
  gapToBest: number | null;
  isPlayer: boolean;
  fastest: boolean;
}

interface Col {
  id: string;
  w: string;
  head: string;
  align: "l" | "r" | "c";
  cell: (x: RowCtx) => ReactNode;
}

// --- position-change animation -----------------------------------------
// Same system as Relative.tsx: rows are keyed by stable car identity
// (`carIdx`), never by list position, so an overtake reorders `top` on the
// same DOM node instead of remounting it. Standings is class-grouped, so the
// slot model runs *per class group* — each group is its own little
// relatively-positioned box, and cars slide within their group. A car moving
// between groups (class change) or in/out of the row budget is treated as an
// exit+enter fade rather than a slide, since sliding across a class header
// would look wrong. Class headers themselves stay in normal document flow
// (no slot tracking): they reposition instantly when a group's row count
// changes, which the design explicitly allows ("can stay static").
//
// TODO: share with Relative.tsx's row animation once both settle.

// TODO: share deriveStandingsRows with Relative once both settle.

const SLIDE_MS = 400; // position-swap glide (F1 timing-tower feel)

interface StandingsRowState {
  carIdx: number;
  slot: number;
  exiting: boolean;
}

interface HighlightEvent {
  id: number;
  kind: "gain" | "loss";
}

/** Reconcile a class group's previous row list against this tick's visible
 *  slots. Identical shape to Relative's `deriveRelativeRows` — see there for
 *  the full rationale, including the `capacity` cap that keeps a lingering
 *  exit-fade from inflating a group's (and so the whole widget's) measured
 *  height and tripping FitContent's shrink-to-fit mid-swap. */
function deriveStandingsRows(prev: StandingsRowState[], visibleIdx: Map<number, number>, capacity: number): StandingsRowState[] {
  let changed = false;
  const next: StandingsRowState[] = [];
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
      next.push({ ...r, exiting: true }); // just dropped out of this group's display
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

interface StandingsRowProps {
  x: RowCtx;
  slot: number;
  exiting: boolean;
  /** Slot pitch in em (equals row box — no gap, matching Relative). */
  rowh: number;
  template: string;
  cols: Col[];
  ta: (a: Col["align"]) => React.CSSProperties["textAlign"];
  theme: Theme;
  highlight: HighlightEvent | null;
  onExited: (carIdx: number) => void;
}

/** One standings row — shared DriverRowShell + dynamic column cells. */
function StandingsRow({ x, slot, exiting, rowh, template, cols, ta, theme, highlight, onExited }: StandingsRowProps) {
  const t = theme.colors;
  return (
    <DriverRowShell
      slot={slot}
      rowH={rowh}
      isPlayer={x.isPlayer}
      exiting={exiting}
      steadyOpacity={x.car.onPitRoad === true && !x.isPlayer ? 0.72 : 1}
      gridTemplateColumns={template}
      theme={theme}
      slideMs={SLIDE_MS}
      onExited={() => onExited(x.car.carIdx)}
      style={{ color: x.isPlayer ? "#fff" : t.textDim }}
    >
      {highlight && <PositionFlash eventId={highlight.id} color={flashColor(highlight.kind, t)} />}
      {cols.map((c) => (
        <div key={c.id} style={{ minWidth: 0, textAlign: ta(c.align) }}>
          {c.cell(x)}
        </div>
      ))}
    </DriverRowShell>
  );
}

function Standings({ theme, config, caps, size, allocatedSize }: BaseWidgetProps<StandingsConfig>) {
  const allocation = allocatedSize ?? size;
  const slow = useSlow();
  const capsLive = useCaps() ?? caps;
  const playerIdx = slow?.playerCarIdx ?? null;
  const t = theme.colors;
  const mono = theme.font.mono;
  const density = standingsDensity(!!config.compact, theme.list);
  const metaPadL = theme.list.metaPadL;

  // Full session roster — everyone in standings, including drivers in other
  // practice entities or still in the garage. Relative filters `inWorld` so only
  // cars actually loaded near you show as neighbours; standings is always global.
  const field = slow?.cars ?? [];
  const showSof = (capsLive?.irating ?? false) && field.some((c) => c.irating != null);
  const fieldSof = useMemo(() => strengthOfField(field), [field]);
  const sofByClass = useMemo(() => {
    const byClass = new Map<number | null, CarEntry[]>();
    for (const c of field) {
      const id = c.carClassId ?? null;
      const list = byClass.get(id);
      if (list) list.push(c);
      else byClass.set(id, [c]);
    }
    const out = new Map<number | null, number>();
    for (const [id, list] of byClass) {
      const sof = strengthOfField(list);
      if (sof != null) out.set(id, sof);
    }
    return out;
  }, [field]);
  const { provPos, provClassPos } = useMemo(() => buildProvisionalPositions(field), [field]);
  let cars = [...field];
  const playerClass = cars.find((c) => c.isPlayer || c.carIdx === playerIdx)?.carClassId ?? null;
  if (config.myClassOnly && playerClass != null) cars = cars.filter((c) => c.carClassId === playerClass);

  // Auto-detect: two or more distinct class ids → multiclass grouping / class pos.
  // "My class only" collapses this to a single-class view by design.
  const numClasses = new Set(cars.map((c) => c.carClassId ?? null)).size;
  const multiclass = numClasses > 1;

  const sortKey = (c: CarEntry) => standingSortKey(c, multiclass, provPos, provClassPos);
  cars = [...cars].sort((a, b) => sortKey(a) - sortKey(b));

  // Size-aware row budget: measure how many rows actually fit the box (real font
  // px includes the per-widget scale), capped by `maxRows`. Drives how many cars
  // we show across all classes.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [fitRows, setFitRows] = useState(99);
  // Real font px (includes the per-widget scale) — also used below to size the
  // per-group animation slot so it reserves exactly the same vertical space
  // the row used to occupy in normal flow (row box + gap).
  const [fontPx, setFontPx] = useState(13);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || allocation.h <= 0) return;
    const measure = () => {
      const fontPx = parseFloat(getComputedStyle(el).fontSize) || 13;
      const nc = multiclass ? numClasses : 0;
      // Exact per-element heights (em → px) so we only ever fit WHOLE rows:
      //   row box · column header 1.7em · class header · SOF bar.
      // Column headers are per group (under each SOF/meta bar), so count them that way.
      const rowH = density.rowH * fontPx + density.rowGapPx;
      const colH = 1.7 * fontPx;
      const classH = nc * (1.35 * fontPx + 8);
      const sofBarH = !multiclass && showSof && fieldSof != null ? 1.2 * fontPx + 6 : 0;
      const headerGroups = Math.max(1, multiclass ? numClasses : 1);
      // Row budget comes from the user's allocated resize box, not the
      // content-hugging chrome height — otherwise shrinking the panel hides rows.
      const fit = Math.max(1, Math.floor((allocation.h - 4 - headerGroups * colH - classH - sofBarH - 4) / rowH));
      setFitRows((p) => (p === fit ? p : fit));
      setFontPx((p) => (p === fontPx ? p : fontPx));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [multiclass, numClasses, showSof, fieldSof, allocation.h, density.rowH, density.rowGapPx]);
  // Slot pitch (em) — flush rows, no gap (Relative-matched).
  const ROWH_EM = density.rowH + density.rowGapPx / fontPx;

  // App palette (blue/purple/green/red), assigned by class order — overrides
  // whatever color the sim reports, so classes read consistently. Computed from
  // the FULL field (not the filtered list) so every widget agrees on the colors.
  const ccol = classColorMap(slow?.cars ?? []);

  // NOTE: no early return here for the empty-field case — every hook below
  // (useRef/useState/useEffect/useCallback) must run on every render
  // regardless of whether there's data, or React's hook-call-order invariant
  // breaks the moment the field appears/disappears (session start, a
  // disconnect). The "No field data" message is instead a branch in the
  // final `return` at the bottom, once all hooks have been called.
  const fastestBest = Math.min(...cars.map((c) => c.bestLapS ?? Infinity));
  const has = {
    delta: cars.some((c) => c.positionsGained != null),
    car: config.showCarIcon && cars.some((c) => carIconFor(c.carScreenName)),
    flag: config.showFlag && cars.some((c) => c.country),
    lic: config.showLicense && cars.some((c) => c.safetyRating),
    ir: config.showIrating && (capsLive?.irating ?? false) && cars.some((c) => c.irating != null),
    tyre: config.showTyre && cars.some((c) => c.tyre),
    lapTrend: cars.some((c) => c.lapDeltaVsAvgS != null),
  };

  const numCell = (s: string, color: string): ReactNode => (
    <span style={{ fontFamily: mono, fontVariantNumeric: "tabular-nums", textAlign: "right", color }}>{s}</span>
  );

  // Build the column set.
  const cols: Col[] = [];
  cols.push({
    id: "pos", w: "2.85em", head: "POS", align: "l",
    cell: (x) => {
      const { pos, provisional } = standingPosOf(x.car, multiclass, provPos, provClassPos);
      if (pos == null) return <span style={{ color: t.textDim2 }}>--</span>;
      return <PosChip pos={pos} provisional={provisional} isPlayer={x.isPlayer} theme={theme} rowH={density.rowH} />;
    },
  });
  if (has.delta)
    cols.push({
      id: "delta", w: "1.8em", head: "", align: "c",
      cell: (x) => {
        const d = x.car.positionsGained ?? 0;
        const icon = d > 0 ? "▲" : d < 0 ? "▼" : "–";
        return <span style={{ fontFamily: mono, fontSize: "0.74em", textAlign: "center", color: d > 0 ? t.gain : d < 0 ? t.loss : t.textDim2 }}>{icon}{d !== 0 ? Math.abs(d) : ""}</span>;
      },
    });
  if (has.car)
    cols.push({
      // Same base as Relative rows; CarIcon applies its own per-brand calibration.
      id: "car", w: "2.2em", head: "", align: "c",
      cell: (x) => {
        // Known make → brand badge; unknown → generic iRacing badge (the column
        // itself is dropped when no car in the field has a known make).
        const ic = carIconFor(x.car.carScreenName) ?? iracingIcon;
        return (
          <span style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <CarIcon src={ic} color={x.isPlayer ? "#fff" : t.text} size={density.carIcon} />
          </span>
        );
      },
    });
  cols.push({
    id: "num",
    w: "2.3em",
    head: "#",
    align: "r",
    cell: (x) => (x.car.carNumber ? numCell("#" + x.car.carNumber, t.textDim) : numCell("--", t.textDim2)),
  });
  if (has.flag)
    cols.push({
      id: "flag", w: "1.4em", head: "", align: "c",
      cell: (x) => (
        <span style={{ display: "flex", height: `${density.rowH}em`, alignItems: "center", justifyContent: "center" }}>
          <FlagSwatch country={x.car.country} />
        </span>
      ),
    });
  cols.push({
    id: "name", w: "minmax(6em,2fr)", head: "DRIVER", align: "l",
    cell: (x) => (
      <span style={{ display: "flex", alignItems: "center", gap: "0.75em", overflow: "hidden", height: `${density.rowH}em`, minWidth: 0, lineHeight: 1 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, lineHeight: 1, color: x.isPlayer ? "#fff" : t.text }}>
          {formatDriverName(x.car.driverName, config.nameFormat === "short" ? "short" : "full", `Car ${x.car.carIdx}`)}
        </span>
        {x.car.onPitRoad === true && <PitBadge color={t.amber} theme={theme} />}
      </span>
    ),
  });
  if (has.lic)
    cols.push({
      id: "lic", w: "minmax(4.1em,1fr)", head: "SR", align: "l",
      cell: (x) => {
        const lic = parseLicense(x.car.safetyRating);
        if (!lic) return <span />;
        // Row-height flex wrapper so the badge is centered by flex, not by the text
        // baseline (which left it visibly high).
        return (
          <span style={{ display: "flex", height: `${density.rowH}em`, alignItems: "center", justifyContent: "flex-start" }}>
            <LicenseBadge letter={lic.letter} sr={lic.sr} theme={theme} />
          </span>
        );
      },
    });
  if (has.ir)
    cols.push({
      id: "ir",
      w: "minmax(3.9em,1fr)",
      head: "iR",
      align: "l",
      cell: (x) => {
        const ir = x.car.irating;
        const d = x.car.iratingDelta;
        // Rating + fixed delta slot; left-aligned so values sit under the iR header.
        return (
          <span style={{ display: "flex", justifyContent: "flex-start", alignItems: "baseline", fontFamily: mono, fontVariantNumeric: "tabular-nums", color: t.text }}>
            <span>{ir != null ? (ir / 1000).toFixed(1) + "k" : "--"}</span>
            <span style={{ display: "inline-block", width: "1.9em", textAlign: "left", fontSize: "0.72em", marginLeft: 3, color: d == null ? "transparent" : d >= 0 ? t.gain : t.loss }}>
              {d != null ? `${d >= 0 ? "▲" : "▼"}${Math.abs(d)}` : ""}
            </span>
          </span>
        );
      },
    });
  cols.push({
    id: "gap",
    w: "minmax(2.9em,1fr)",
    head: "GAP",
    align: "r",
    cell: (x) => {
      if (x.gapToBest == null) return numCell("--", t.textDim2);
      // Holds the class/session best — no delta to show.
      if (x.gapToBest <= 0.0005) return numCell("—", t.best);
      return numCell(`+${x.gapToBest.toFixed(3)}`, t.text);
    },
  });
  if (config.showLastLap) cols.push({ id: "last", w: "minmax(4.4em,1fr)", head: "LAST", align: "r", cell: (x) => numCell(fmtLapTime(x.car.lastLapS), t.textDim) });
  if (has.lapTrend)
    cols.push({
      id: "trend",
      w: "minmax(2.4em,1fr)",
      head: "Δ",
      align: "r",
      cell: (x) => {
        const d = x.car.lapDeltaVsAvgS;
        if (d == null) return numCell("--", t.textDim2);
        const color = d < -0.05 ? t.gain : d > 0.05 ? t.loss : t.textDim;
        return numCell(fmtDelta(d), color);
      },
    });
  if (config.showBest) cols.push({ id: "best", w: "minmax(4.4em,1fr)", head: "BEST", align: "r", cell: (x) => numCell(fmtLapTime(x.car.bestLapS), x.car.bestLapS != null && x.car.bestLapS === fastestBest ? t.best : t.text) });
  if (has.tyre)
    cols.push({
      id: "tyre", w: "minmax(1.8em,1fr)", head: "", align: "c",
      cell: (x) => (
        <span style={{ display: "flex", height: `${density.rowH}em`, alignItems: "center", justifyContent: "center" }}>
          <TyreBadge compound={x.car.tyre} />
        </span>
      ),
    });

  const template = cols.map((c) => c.w).join(" ");
  const COLGAP = theme.list.colGap;
  const ROW_PAD = driverRowPad(theme);
  const ta = (a: Col["align"]): React.CSSProperties["textAlign"] => (a === "r" ? "right" : a === "c" ? "center" : "left");

  // Group by class ID (preserving first-seen order) or a single group. We key on
  // the ID — not the name — because iRacing often leaves the short class name
  // blank, which would otherwise collapse every class into one nameless group.
  const groups: { id: number | null; name: string | null; color: number | null; rows: RowCtx[]; display: RowCtx[] }[] = [];
  const pushCar = (car: CarEntry) => {
    const id = car.carClassId ?? null;
    let g = multiclass ? groups.find((x) => x.id === id) : groups[0];
    if (!g) {
      g = { id: multiclass ? id : null, name: null, color: car.classColor, rows: [], display: [] };
      groups.push(g);
    }
    g.rows.push({ car, pos: null, gapToBest: null, isPlayer: car.isPlayer || car.carIdx === playerIdx, fastest: false });
  };
  cars.forEach(pushCar);

  // Label each class and re-sort rows within the group by effective position
  // (class-first in multiclass mode) — the initial field sort is overall and
  // can mis-order cars inside a class when live class positions are still null.
  groups.forEach((g, i) => {
    g.rows.sort((a, b) => sortKey(a.car) - sortKey(b.car));
    const named = g.rows.map((r) => r.car.carClassName).find((n) => n && n.trim());
    const model = g.rows.map((r) => r.car.carScreenName).find((m) => m && m.trim());
    g.name = multiclass ? named?.trim() || model?.trim() || `Class ${i + 1}` : null;
  });

  // Per-group: best-lap gap vs class best (GAP; single-class = session best)
  // and displayed position.
  for (const g of groups) {
    const classBestLap = Math.min(...g.rows.map((r) => r.car.bestLapS ?? Infinity));
    g.rows.forEach((r) => {
      r.gapToBest =
        classBestLap < Infinity && r.car.bestLapS != null
          ? r.car.bestLapS - classBestLap
          : null;
      r.fastest = r.car.bestLapS != null && r.car.bestLapS === classBestLap;
      r.pos = standingPosOf(r.car, multiclass, provPos, provClassPos).pos;
    });
  }

  // Distribute the row budget across classes so all classes stay visible, and the
  // surplus goes to the player's own class. The budget tracks the box height.
  const budget = Math.min(config.maxRows, Math.max(groups.length, fitRows));
  const MIN_PER_CLASS = 3;
  const playerGi = groups.findIndex((g) => g.rows.some((r) => r.isPlayer));
  const counts = groups.map((g) => Math.min(MIN_PER_CLASS, g.rows.length));
  let used = counts.reduce((a, b) => a + b, 0);
  // Too many classes for the budget → trim non-player classes (then the player's), to 1.
  for (let i = groups.length - 1; i >= 0 && used > budget; i--) {
    if (i === playerGi) continue;
    while (counts[i] > 1 && used > budget) { counts[i]--; used--; }
  }
  while (used > budget && playerGi >= 0 && counts[playerGi] > 1) { counts[playerGi]--; used--; }
  // Surplus → the player's class first, then any leftover to the others.
  let rem = budget - used;
  if (rem > 0 && playerGi >= 0) {
    const add = Math.min(rem, groups[playerGi].rows.length - counts[playerGi]);
    counts[playerGi] += add;
    rem -= add;
  }
  for (let i = 0; i < groups.length && rem > 0; i++) {
    const add = Math.min(rem, groups[i].rows.length - counts[i]);
    counts[i] += add;
    rem -= add;
  }
  // Pick which rows to show per class:
  //  - always pin the top 3 (podium / class leaders)
  //  - fill the remaining budget with a window around the player (so you still
  //    see your battle). Other classes (no player) just show their leaders.
  const TOP_KEEP = 3;
  groups.forEach((g, i) => {
    const n = counts[i];
    if (n >= g.rows.length) {
      g.display = g.rows;
      return;
    }
    if (n <= 0) {
      g.display = [];
      return;
    }

    const pIdx = g.rows.findIndex((r) => r.isPlayer);
    if (pIdx < 0) {
      g.display = g.rows.slice(0, n);
      return;
    }

    const topCount = Math.min(TOP_KEEP, n, g.rows.length);
    const leaders = g.rows.slice(0, topCount);
    if (n <= topCount) {
      g.display = leaders;
      return;
    }

    const restBudget = n - topCount;
    const leaderIds = new Set(leaders.map((r) => r.car.carIdx));
    const nearPool = g.rows.filter((r) => !leaderIds.has(r.car.carIdx));

    if (nearPool.length <= restBudget) {
      g.display = [...leaders, ...nearPool];
    } else {
      const pNear = nearPool.findIndex((r) => r.isPlayer);
      // Player already in the top N → continue with the cars just outside it.
      const focus = pNear >= 0 ? pNear : 0;
      const start = Math.max(0, Math.min(focus - Math.floor(restBudget / 2), nearPool.length - restBudget));
      g.display = [...leaders, ...nearPool.slice(start, start + restBudget)];
    }
  });

  // Latest RowCtx per car (from the FULL per-group list, not just `display`), so
  // an exiting row (dropped from `display` by the budget, or by leaving its
  // group) keeps rendering its last known state through the fade instead of
  // going blank.
  const carDataRef = useRef<Map<number, RowCtx>>(new Map());
  for (const g of groups) for (const r of g.rows) carDataRef.current.set(r.car.carIdx, r);

  // Gain/loss flash: detected from each group's *full* row list (`g.rows`, the
  // in-class position before the row budget trims it), so a resize-driven
  // change to `display` never fires a false "you passed someone" — only a real
  // position swap does.
  const rankRef = useRef<Map<number, number>>(new Map());
  const highlightsRef = useRef<Map<number, HighlightEvent>>(new Map());
  const hlIdRef = useRef(0);
  {
    const rankMap = new Map<number, number>();
    for (const g of groups) for (const r of g.rows) if (r.pos != null) rankMap.set(r.car.carIdx, r.pos);
    for (const [carIdx, rank] of rankMap) {
      const prevRank = rankRef.current.get(carIdx);
      if (prevRank != null && prevRank !== rank) {
        hlIdRef.current += 1;
        highlightsRef.current.set(carIdx, { id: hlIdRef.current, kind: rank < prevRank ? "gain" : "loss" });
      }
    }
    rankRef.current = rankMap;
  }

  // Row list for the slide animation, one per class group: a superset of
  // `g.display` that keeps a just-departed car around (fading out) until its
  // exit transition finishes. Gated on `groupsSig` (not `groups` itself, which
  // is a fresh array every render) so this only fires when a group's
  // membership/order/capacity actually changes.
  const [rowsByGroup, setRowsByGroup] = useState<Map<string, StandingsRowState[]>>(new Map());
  // A plain (unmemoized) string is fine here — it's O(cars) to build, cheap at
  // slow-path rates, and it's the resulting primitive value (not how it was
  // computed) that gates the effect below.
  const groupsSig = groups.map((g, i) => `${g.id ?? "all"}:${g.display.map((r) => r.car.carIdx).join(",")}:${counts[i]}`).join("|");
  useLayoutEffect(() => {
    setRowsByGroup((prev) => {
      const next = new Map<string, StandingsRowState[]>();
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const key = String(g.id ?? "all");
        const visibleIdx = new Map(g.display.map((r, slot): [number, number] => [r.car.carIdx, slot]));
        next.set(key, deriveStandingsRows(prev.get(key) ?? [], visibleIdx, counts[i]));
      }
      return next;
    });
    // `groups`/`counts` are intentionally omitted — `groupsSig` already encodes
    // everything about them (membership + order + capacity) that should
    // retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupsSig]);

  const handleExited = useCallback((groupKey: string, carIdx: number) => {
    setRowsByGroup((prev) => {
      const rows = prev.get(groupKey);
      if (!rows) return prev;
      const filtered = rows.filter((r) => r.carIdx !== carIdx);
      if (filtered.length === rows.length) return prev;
      const next = new Map(prev);
      next.set(groupKey, filtered);
      return next;
    });
  }, []);

  // The grid container must share the rows' font-size, because the column widths
  // are em-based — shrinking the header's font-size here would shrink every column
  // and slide the labels out from under their data. So keep the container at the
  // row size and make only the label text small (on an inner span).
  const header = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: template,
        gap: COLGAP,
        alignItems: "center",
        height: theme.list.headerH,
        padding: ROW_PAD,
        boxSizing: "border-box",
        background: theme.list.headerBg,
        boxShadow: theme.list.headerShadow,
      }}
    >
      {cols.map((c) => (
        <span
          key={c.id}
          style={{
            display: "flex",
            justifyContent: c.align === "r" ? "flex-end" : c.align === "c" ? "center" : "flex-start",
            alignItems: "baseline",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              fontFamily: theme.font.label,
              color: t.textDim,
              fontSize: theme.list.headerLabelSize,
              fontWeight: 800,
              letterSpacing: theme.list.headerTracking,
              ...(c.id === "pos" ? { paddingLeft: metaPadL } : null),
            }}
          >
            {c.head}
          </span>
        </span>
      ))}
    </div>
  );

  if (cars.length === 0) {
    return <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: t.textDim, fontSize: "0.85em" }}>No field data</div>;
  }

  const showSofBar = !multiclass && showSof && fieldSof != null;
  // Visible vs full roster for the single-class "N OF M" chip.
  const singleGroup = !multiclass ? groups[0] : null;
  const shownCount = singleGroup?.display.length ?? cars.length;
  const totalCount = singleGroup?.rows.length ?? cars.length;
  const contentHeightPx = Math.min(standingsContentHeightPx(groups, rowsByGroup, fontPx, multiclass, showSofBar, density), allocation.h);

  return (
    <div
      ref={rootRef}
      style={{
        width: "100%",
        height: contentHeightPx,
        maxHeight: "100%",
        overflow: "hidden",
        color: t.text,
        padding: 0,
        boxSizing: "border-box",
        fontSize: `${density.font}em`,
      }}
    >
      {groups.map((g) => {
        const key = String(g.id ?? "all");
        const rows = rowsByGroup.get(key) ?? [];
        // Slot container height covers whichever is taller right now: the
        // steady-state display list, or the row-state list while an exit fade
        // is still lingering. `deriveStandingsRows`'s capacity cap keeps this
        // from growing unbounded and inflating the widget via FitContent.
        const boxRows = Math.max(g.display.length, rows.length);
        return (
          <div key={g.id ?? "all"}>
            {/* Meta (SOF / class / driver count) sits above the column headers;
                headers sit directly on top of this group's sunken row trough. */}
            {multiclass && g.name ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: `6px ${density.padR} 4px ${metaPadL}`, height: "1.35em", boxSizing: "content-box" }}>
                <span style={{ fontFamily: theme.font.label, fontWeight: 800, fontSize: "0.82em", letterSpacing: "0.04em", color: "#0a0b0e", padding: "2px 8px", borderRadius: 4, background: classColorOf(ccol, g.id) }}>{g.name}</span>
                {showSof && sofByClass.get(g.id ?? null) != null && (
                  <SofValue value={sofByClass.get(g.id ?? null)!} theme={theme} mono={mono} t={t} />
                )}
                <span style={{ fontFamily: theme.font.label, marginLeft: "auto", fontSize: "0.78em", color: t.text, letterSpacing: "0.06em", fontWeight: 800, fontVariantNumeric: "tabular-nums", opacity: 0.92 }}>
                  {g.display.length < g.rows.length ? `${g.display.length} OF ${g.rows.length}` : `${g.rows.length} CARS`}
                </span>
              </div>
            ) : showSofBar ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: `5px ${density.padR} 4px ${metaPadL}`, height: "1.2em", boxSizing: "content-box" }}>
                <SofValue value={fieldSof} theme={theme} mono={mono} t={t} />
                <span style={{ fontFamily: theme.font.label, marginLeft: "auto", fontSize: "0.78em", color: t.text, letterSpacing: "0.06em", fontWeight: 800, fontVariantNumeric: "tabular-nums", opacity: 0.92 }}>
                  {shownCount < totalCount ? `${shownCount} OF ${totalCount}` : `${totalCount} CARS`}
                </span>
              </div>
            ) : null}
            {header}
            <DriverListTrough slots={boxRows} rowH={ROWH_EM} theme={theme}>
              {rows.map((r) => {
                const x = carDataRef.current.get(r.carIdx);
                if (!x) return null;
                const highlight = highlightsRef.current.get(r.carIdx) ?? null;
                return (
                  <StandingsRow
                    key={r.carIdx}
                    x={x}
                    slot={r.slot}
                    exiting={r.exiting}
                    rowh={ROWH_EM}
                    template={template}
                    cols={cols}
                    ta={ta}
                    theme={theme}
                    highlight={highlight}
                    onExited={(carIdx) => handleExited(key, carIdx)}
                  />
                );
              })}
            </DriverListTrough>
          </div>
        );
      })}
    </div>
  );
}

// Narrowest box (design px, scale 1) that fits the columns the given config
// enables, so the grid never overflows/clips. The em-widths mirror the column
// template built in <Standings> above; rows render at density.font of the
// 14px base. The data-driven delta/number columns are
// assumed present (they almost always are) so the floor stays safe.
function standingsMinWidth(config: StandingsConfig): number {
  const d = standingsDensity(!!config.compact, defaultTheme.list);
  const EM = d.font * 14;
  const colEms = [2.85, 1.8, 2.3]; // pos · delta · number
  if (config.showCarIcon) colEms.push(2.2);
  if (config.showFlag) colEms.push(1.4);
  colEms.push(6); // driver name (minmax(6em,…) lower bound)
  if (config.showLicense) colEms.push(4.1);
  if (config.showIrating) colEms.push(3.9);
  colEms.push(2.9); // gap
  if (config.showLastLap) colEms.push(4.4);
  if (config.showBest) colEms.push(4.4);
  if (config.showTyre) colEms.push(1.8);
  const padEm = parseFloat(d.padL) + parseFloat(d.padR);
  const sumEm = colEms.reduce((a, b) => a + b, 0) + parseFloat(defaultTheme.list.colGap) * (colEms.length - 1) + padEm;
  return Math.ceil(sumEm * EM);
}

export const standingsDef: WidgetDefinition<StandingsConfig> = {
  id: "standings",
  name: "Standings",
  defaultSize: { w: 860, h: 420 },
  minSize: { w: 360, h: 160 },
  minContentWidth: standingsMinWidth,
  hugContentHeight: true,
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [
    { key: "maxRows", label: "Max rows", type: "number", min: 3, max: 30, step: 1 },
    { key: "myClassOnly", label: "My class only", type: "boolean" },
    { key: "compact", label: "Compact", type: "boolean" },
    { key: "showLastLap", label: "Last lap", type: "boolean" },
    { key: "showBest", label: "Best lap", type: "boolean" },
    { key: "showIrating", label: "iRating", type: "boolean" },
    { key: "showFlag", label: "Flags", type: "boolean" },
    { key: "showLicense", label: "License", type: "boolean" },
    { key: "showTyre", label: "Tyre", type: "boolean" },
    { key: "showCarIcon", label: "Car icon", type: "boolean" },
    {
      key: "nameFormat",
      label: "Driver names",
      type: "enum",
      options: [
        { value: "full", label: "First Last" },
        { value: "short", label: "F. Last" },
      ],
    },
  ],
  Component: Standings,
};
