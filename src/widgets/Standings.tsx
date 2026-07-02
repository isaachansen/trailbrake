// Standings: rich, optionally multi-class grouped field — position change, car
// number, country flag, driver, license badge, iRating (+delta), gap, interval,
// last/best lap, tyre compound. Slow-path widget.
//
// Columns are built dynamically and a column is dropped entirely when no car can
// fill it, so a sim that doesn't expose (say) tyre or flag data degrades cleanly.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSlow, useCaps } from "../store/hooks";
import { fmtGap, fmtLapTime, hexToRgba } from "./format";
import { flagOf, parseLicense, classColorMap, classColorOf } from "./raceColors";
import { LicenseBadge } from "./LicenseBadge";
import { TyreBadge } from "./TyreBadge";
import { PitBadge } from "./PitBadge";
import { CarIcon, carIconFor, iracingIcon, isWideIcon } from "./carIcons";
import type { CarEntry } from "../store/types";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";
import type { Theme } from "../theme/theme";

export interface StandingsConfig {
  maxRows: number;
  multiclass: boolean;
  myClassOnly: boolean;
  showInterval: boolean;
  showLastLap: boolean;
  showBest: boolean;
  showIrating: boolean;
  showFlag: boolean;
  showLicense: boolean;
  showTyre: boolean;
  showCarIcon: boolean;
}

const defaultConfig: StandingsConfig = {
  maxRows: 16,
  multiclass: true,
  myClassOnly: false,
  showInterval: true,
  showLastLap: true,
  showBest: true,
  showIrating: true,
  showFlag: true,
  showLicense: true,
  showTyre: true,
  showCarIcon: true,
};

interface RowCtx {
  car: CarEntry;
  pos: number | null;
  /** Gap to the class leader in seconds; null when the sim has no gap for this car. */
  gapToLeader: number | null;
  interval: number | null;
  isFirst: boolean;
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

const SLIDE_MS = 400; // position-swap glide (F1 timing-tower feel)
const ENTER_MS = 240; // fade-in when a car enters the visible rows
const EXIT_MS = 240; // fade-out when a car leaves the visible rows
const FLASH_MS = 900; // brief gain/loss tint after a position change

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

/** A brief tinted overlay for a row that just gained or lost a position.
 *  Mounts opaque (no transition) so it appears instantly, then flips to
 *  transparent on the next paint so the fade-out plays as a proper CSS
 *  transition — independent of the ~200ms slow-path tick rate. */
function PositionFlash({ event, color }: { event: HighlightEvent; color: string }) {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    setFaded(false);
    const raf = requestAnimationFrame(() => setFaded(true));
    return () => cancelAnimationFrame(raf);
  }, [event.id]);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 8,
        pointerEvents: "none",
        background: color,
        opacity: faded ? 0 : 1,
        transition: faded ? `opacity ${FLASH_MS}ms ease-out` : "none",
      }}
    />
  );
}

interface StandingsRowProps {
  x: RowCtx;
  slot: number;
  exiting: boolean;
  rowh: number;
  template: string;
  colgap: string;
  padx: string;
  cols: Col[];
  ta: (a: Col["align"]) => React.CSSProperties["textAlign"];
  ccol: Map<number, string>;
  t: Theme["colors"];
  highlight: HighlightEvent | null;
  onExited: (carIdx: number) => void;
}

/** One standings row. Kept as its own component (module scope) purely so it
 *  can own the tiny bit of local state an enter fade needs: render invisible
 *  on mount, then flip to visible next paint so the opacity transition
 *  actually plays. */
function StandingsRow({ x, slot, exiting, rowh, template, colgap, padx, cols, ta, ccol, t, highlight, onExited }: StandingsRowProps) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const steadyOpacity = x.car.onPitRoad === true && !x.isPlayer ? 0.72 : 1;
  const opacity = exiting || !entered ? 0 : steadyOpacity;

  return (
    <div
      onTransitionEnd={(e) => {
        // Only the opacity leg matters here — `top`/`background` also transition
        // on this node and would otherwise fire spurious "exit" removals.
        if (exiting && e.propertyName === "opacity") onExited(x.car.carIdx);
      }}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: `${slot * rowh}em`,
        display: "grid",
        gridTemplateColumns: template,
        gap: colgap,
        alignItems: "center",
        height: "1.9em",
        padding: `0 ${padx}`,
        borderRadius: 8,
        background: x.isPlayer ? "rgba(255, 45, 142, 0.32)" : hexToRgba(classColorOf(ccol, x.car.carClassId), 0.16),
        boxShadow: x.isPlayer ? `inset 0 0 0 1.5px ${t.accent}` : "none",
        color: x.isPlayer ? "#fff" : t.textDim,
        fontWeight: x.isPlayer ? 800 : 500,
        opacity,
        // The mover glides past its neighbor on `top`; opacity handles the
        // enter/exit fade (a shorter duration than the slide so departures feel
        // brisk rather than draggy).
        transition: `top ${SLIDE_MS}ms cubic-bezier(.4,0,.2,1), opacity ${exiting ? EXIT_MS : ENTER_MS}ms ease-out, background 0.2s`,
      }}
    >
      {highlight && <PositionFlash event={highlight} color={hexToRgba(highlight.kind === "gain" ? t.gain : t.loss, 0.32)} />}
      {cols.map((c) => (
        <div key={c.id} style={{ minWidth: 0, textAlign: ta(c.align) }}>
          {c.cell(x)}
        </div>
      ))}
    </div>
  );
}

function Standings({ theme, config, caps }: BaseWidgetProps<StandingsConfig>) {
  const slow = useSlow();
  const capsLive = useCaps() ?? caps;
  const playerIdx = slow?.playerCarIdx ?? null;
  const t = theme.colors;
  const mono = theme.font.mono;

  let cars = [...(slow?.cars ?? [])].filter((c) => c.inWorld !== false).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  const playerClass = cars.find((c) => c.isPlayer || c.carIdx === playerIdx)?.carClassId ?? null;
  if (config.myClassOnly && playerClass != null) cars = cars.filter((c) => c.carClassId === playerClass);

  // Distinct classes among the shown cars — drives the row-fit measurement below
  // (each class header costs a row's worth of height in multiclass mode).
  const numClasses = new Set(cars.map((c) => c.carClassId ?? null)).size;

  // Size-aware row budget: measure how many rows actually fit the box (real font
  // px includes the per-widget scale), capped by `maxRows`. Drives how many cars
  // we show across all classes.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [fitRows, setFitRows] = useState(99);
  // Real font px (includes the per-widget scale) — also used below to size the
  // per-group animation slot so it reserves exactly the same vertical space
  // the row used to occupy in normal flow (1.9em row + 2px/2px margin).
  const [fontPx, setFontPx] = useState(13);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const fontPx = parseFloat(getComputedStyle(el).fontSize) || 13;
      const nc = config.multiclass ? numClasses : 0;
      // Exact per-element heights (em → px) so we only ever fit WHOLE rows:
      //   row 1.9em + 4px margin · column header 1.6em · class header 1.3em + 10px margin.
      const rowH = 1.9 * fontPx + 4;
      const colH = 1.6 * fontPx;
      const classH = nc * (1.3 * fontPx + 10);
      // Root padding (12, from the 6px 10px outer padding) + a small safety
      // margin so the last row is never clipped and there's always clean
      // padding at the bottom.
      const fit = Math.max(1, Math.floor((el.clientHeight - 12 - colH - classH - 6) / rowH));
      setFitRows((p) => (p === fit ? p : fit));
      setFontPx((p) => (p === fontPx ? p : fontPx));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [config.multiclass, numClasses]);
  // Slot height (em) for one animated row, matching the `rowH` used in the fit
  // measurement above so the absolute-positioned layout reserves the same
  // space natural flow used to.
  const ROWH_EM = 1.9 + 4 / fontPx;

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
    num: cars.some((c) => c.carNumber),
    flag: config.showFlag && cars.some((c) => c.country),
    lic: config.showLicense && cars.some((c) => c.safetyRating),
    ir: config.showIrating && (capsLive?.irating ?? false) && cars.some((c) => c.irating != null),
    tyre: config.showTyre && cars.some((c) => c.tyre),
  };

  const numCell = (s: string, color: string): ReactNode => (
    <span style={{ fontFamily: mono, fontVariantNumeric: "tabular-nums", textAlign: "right", color }}>{s}</span>
  );

  // Build the column set.
  const cols: Col[] = [];
  cols.push({
    id: "pos", w: "2.1em", head: "P", align: "l",
    cell: (x) =>
      x.pos == null ? (
        <span style={{ color: t.textDim2 }}>--</span>
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: "1.55em",
            height: "1.55em",
            padding: "0 0.25em",
            borderRadius: 5,
            background: "rgba(0,0,0,0.28)",
            fontVariantNumeric: "tabular-nums",
            fontWeight: x.isPlayer ? 800 : 700,
            color: x.isPlayer ? "#fff" : t.text,
          }}
        >
          {x.pos}
        </span>
      ),
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
      // Round badges use the same 1.5em as the Relative rows; the wide, low-profile
      // logos (Chevy/Ford/Dallara/McLaren) get the larger 1.63em tier so they
      // don't read small.
      id: "car", w: "2em", head: "", align: "c",
      cell: (x) => {
        // Known make → brand badge; unknown → generic iRacing badge (the column
        // itself is dropped when no car in the field has a known make).
        const ic = carIconFor(x.car.carScreenName) ?? iracingIcon;
        return (
          <span style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <CarIcon src={ic} color={x.isPlayer ? "#fff" : t.text} size={isWideIcon(ic) ? "1.63em" : "1.5em"} />
          </span>
        );
      },
    });
  if (has.num) cols.push({ id: "num", w: "2.3em", head: "#", align: "r", cell: (x) => (x.car.carNumber ? numCell("#" + x.car.carNumber, t.textDim) : numCell("--", t.textDim2)) });
  if (has.flag)
    cols.push({
      id: "flag", w: "1.4em", head: "", align: "c",
      cell: (x) => <span style={{ display: "inline-block", width: "1.2em", height: "0.82em", borderRadius: 2, background: flagOf(x.car.country), boxShadow: "inset 0 0 0 1px rgba(0,0,0,.35)" }} />,
    });
  cols.push({
    id: "name", w: "minmax(6em,2fr)", head: "DRIVER", align: "l",
    cell: (x) => (
      <span style={{ display: "flex", alignItems: "center", gap: "0.45em", overflow: "hidden" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: x.isPlayer ? "#fff" : t.text }}>
          {x.car.driverName ?? `Car ${x.car.carIdx}`}
        </span>
        {x.car.onPitRoad === true && <PitBadge color={t.amber} />}
      </span>
    ),
  });
  if (has.lic)
    cols.push({
      id: "lic", w: "minmax(4.1em,1fr)", head: "SR", align: "r",
      cell: (x) => {
        const lic = parseLicense(x.car.safetyRating);
        if (!lic) return <span />;
        // Row-height flex wrapper so the badge is centered by flex, not by the text
        // baseline (which left it visibly high). 1.9em matches the row height.
        return (
          <span style={{ display: "flex", height: "1.9em", alignItems: "center", justifyContent: "flex-end" }}>
            <LicenseBadge letter={lic.letter} sr={lic.sr} />
          </span>
        );
      },
    });
  if (has.ir)
    cols.push({
      id: "ir", w: "minmax(3.9em,1fr)", head: "iR", align: "r",
      cell: (x) => {
        const ir = x.car.irating;
        const d = x.car.iratingDelta;
        // Two fixed slots so the iR value's right edge stays put across rows
        // regardless of how wide the delta is — the digits read as a clean column.
        return (
          <span style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", fontFamily: mono, fontVariantNumeric: "tabular-nums", color: t.text }}>
            <span>{ir != null ? (ir / 1000).toFixed(1) + "k" : "--"}</span>
            <span style={{ display: "inline-block", width: "1.9em", textAlign: "left", fontSize: "0.72em", marginLeft: 3, color: d == null ? "transparent" : d >= 0 ? t.gain : t.loss }}>
              {d != null ? `${d >= 0 ? "▲" : "▼"}${Math.abs(d)}` : ""}
            </span>
          </span>
        );
      },
    });
  cols.push({ id: "gap", w: "minmax(2.9em,1fr)", head: "GAP", align: "r", cell: (x) => (x.isFirst ? numCell("—", t.text) : x.gapToLeader == null ? numCell("--", t.textDim2) : numCell(fmtGap(x.gapToLeader), t.text)) });
  if (config.showInterval) cols.push({ id: "int", w: "minmax(2.7em,1fr)", head: "INT", align: "r", cell: (x) => numCell(x.interval == null ? "—" : fmtGap(x.interval), t.textDim) });
  if (config.showLastLap) cols.push({ id: "last", w: "minmax(4.4em,1fr)", head: "LAST", align: "r", cell: (x) => numCell(fmtLapTime(x.car.lastLapS), t.textDim) });
  if (config.showBest) cols.push({ id: "best", w: "minmax(4.4em,1fr)", head: "BEST", align: "r", cell: (x) => numCell(fmtLapTime(x.car.bestLapS), x.car.bestLapS != null && x.car.bestLapS === fastestBest ? t.best : t.text) });
  if (has.tyre)
    cols.push({
      id: "tyre", w: "minmax(1.8em,1fr)", head: "", align: "c",
      cell: (x) => (
        <span style={{ display: "flex", height: "1.9em", alignItems: "center", justifyContent: "center" }}>
          <TyreBadge compound={x.car.tyre} />
        </span>
      ),
    });

  const template = cols.map((c) => c.w).join(" ");
  const COLGAP = "0.6em";
  const PADX = "0.7em";
  const ta = (a: Col["align"]): React.CSSProperties["textAlign"] => (a === "r" ? "right" : a === "c" ? "center" : "left");

  // Group by class ID (preserving first-seen order) or a single group. We key on
  // the ID — not the name — because iRacing often leaves the short class name
  // blank, which would otherwise collapse every class into one nameless group.
  const groups: { id: number | null; name: string | null; color: number | null; rows: RowCtx[]; display: RowCtx[] }[] = [];
  const pushCar = (car: CarEntry) => {
    const id = car.carClassId ?? null;
    let g = config.multiclass ? groups.find((x) => x.id === id) : groups[0];
    if (!g) {
      g = { id: config.multiclass ? id : null, name: null, color: car.classColor, rows: [], display: [] };
      groups.push(g);
    }
    g.rows.push({ car, pos: null, gapToLeader: null, interval: null, isFirst: false, isPlayer: car.isPlayer || car.carIdx === playerIdx, fastest: false });
  };
  cars.forEach(pushCar);

  // Label each class: short name if the sim gives one, else the car model, else
  // an ordinal — so multiclass always shows a meaningful header.
  groups.forEach((g, i) => {
    const named = g.rows.map((r) => r.car.carClassName).find((n) => n && n.trim());
    const model = g.rows.map((r) => r.car.carScreenName).find((m) => m && m.trim());
    g.name = config.multiclass ? named?.trim() || model?.trim() || `Class ${i + 1}` : null;
  });

  // Per-group: leader gap, interval, displayed position. Cars with no gap data
  // (disconnected/towing) keep null — they show "--" rather than a fabricated 0,
  // are excluded from the leader-gap reference, and never poison a neighbour's INT.
  for (const g of groups) {
    const known = g.rows.map((r) => r.car.gapToPlayerS).filter((v): v is number => v != null);
    const leaderGap = known.length > 0 ? Math.max(...known) : null;
    let prev: number | null = null;
    g.rows.forEach((r, i) => {
      const toPlayer = r.car.gapToPlayerS;
      r.gapToLeader = leaderGap != null && toPlayer != null ? leaderGap - toPlayer : null;
      // Interval to the row above — only when both rows have real gap data.
      r.interval = i === 0 || r.gapToLeader == null || prev == null ? null : r.gapToLeader - prev;
      r.isFirst = i === 0;
      r.pos = config.multiclass ? r.car.classPosition ?? r.car.position : r.car.position;
      prev = r.gapToLeader;
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
  // Pick which rows to show per class: a window around the player for their class
  // (so you always see your battle), the leaders for the rest.
  groups.forEach((g, i) => {
    const n = counts[i];
    if (n >= g.rows.length) { g.display = g.rows; return; }
    const pIdx = g.rows.findIndex((r) => r.isPlayer);
    const start = pIdx >= 0 ? Math.max(0, Math.min(pIdx - Math.floor(n / 2), g.rows.length - n)) : 0;
    g.display = g.rows.slice(start, start + n);
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
  useEffect(() => {
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
  // row size and make only the label text small (on the spans).
  const header = (
    <div style={{ display: "grid", gridTemplateColumns: template, gap: COLGAP, alignItems: "center", height: "1.6em", padding: `0 ${PADX}` }}>
      {cols.map((c) => (
        <span key={c.id} style={{ fontFamily: theme.font.label, textAlign: ta(c.align), color: t.textDim, fontSize: "0.7em", fontWeight: 700, letterSpacing: "0.08em", overflow: "hidden", whiteSpace: "nowrap" }}>{c.head}</span>
      ))}
    </div>
  );

  if (cars.length === 0) {
    return <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: t.textDim, fontSize: "0.85em" }}>No field data</div>;
  }

  return (
    <div ref={rootRef} style={{ width: "100%", height: "100%", overflow: "hidden", color: t.text, padding: "6px 10px", boxSizing: "border-box", fontSize: "0.92em" }}>
      {header}
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
            {config.multiclass && g.name && (
              <div style={{ display: "flex", alignItems: "center", gap: 7, padding: `0 ${PADX}`, margin: "7px 0 3px", height: "1.3em", boxSizing: "content-box" }}>
                <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.74em", letterSpacing: "0.04em", color: "#0a0b0e", padding: "1px 7px", borderRadius: 5, background: classColorOf(ccol, g.id) }}>{g.name}</span>
                <span style={{ fontFamily: theme.font.label, marginLeft: "auto", fontSize: "0.68em", color: t.text, letterSpacing: "0.06em", fontWeight: 800, fontVariantNumeric: "tabular-nums", opacity: 0.92 }}>
                  {g.display.length < g.rows.length ? `${g.display.length} OF ${g.rows.length}` : `${g.rows.length} CARS`}
                </span>
              </div>
            )}
            <div style={{ position: "relative", height: boxRows ? `${boxRows * ROWH_EM}em` : 0 }}>
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
                    colgap={COLGAP}
                    padx={PADX}
                    cols={cols}
                    ta={ta}
                    ccol={ccol}
                    t={t}
                    highlight={highlight}
                    onExited={(carIdx) => handleExited(key, carIdx)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Narrowest box (design px, scale 1) that fits the columns the given config
// enables, so the grid never overflows/clips. The em-widths mirror the column
// template built in <Standings> above; rows render at the root's 0.92em of the
// 14px base, hence EM = 0.92 × 14. The data-driven delta/number columns are
// assumed present (they almost always are) so the floor stays safe.
function standingsMinWidth(config: StandingsConfig): number {
  const EM = 0.92 * 14;
  const colEms = [2.1, 1.8, 2.3]; // pos · delta · number
  if (config.showCarIcon) colEms.push(2);
  if (config.showFlag) colEms.push(1.4);
  colEms.push(6); // driver name (minmax(6em,…) lower bound)
  if (config.showLicense) colEms.push(4.1);
  if (config.showIrating) colEms.push(3.9);
  colEms.push(2.9); // gap
  if (config.showInterval) colEms.push(2.7);
  if (config.showLastLap) colEms.push(4.4);
  if (config.showBest) colEms.push(4.4);
  if (config.showTyre) colEms.push(1.8);
  const sumEm = colEms.reduce((a, b) => a + b, 0) + 0.6 * (colEms.length - 1) /* col gaps */ + 1.4 /* 0.7em PADX ×2 */;
  return Math.ceil(sumEm * EM + 10 /* 5px root padding ×2 */);
}

export const standingsDef: WidgetDefinition<StandingsConfig> = {
  id: "standings",
  name: "Standings",
  defaultSize: { w: 660, h: 345 },
  minSize: { w: 320, h: 140 },
  minContentWidth: standingsMinWidth,
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [
    { key: "maxRows", label: "Max rows", type: "number", min: 3, max: 30, step: 1 },
    { key: "multiclass", label: "Group by class", type: "boolean" },
    { key: "myClassOnly", label: "My class only", type: "boolean" },
    { key: "showInterval", label: "Interval", type: "boolean" },
    { key: "showLastLap", label: "Last lap", type: "boolean" },
    { key: "showBest", label: "Best lap", type: "boolean" },
    { key: "showIrating", label: "iRating", type: "boolean" },
    { key: "showFlag", label: "Flags", type: "boolean" },
    { key: "showLicense", label: "License", type: "boolean" },
    { key: "showTyre", label: "Tyre", type: "boolean" },
    { key: "showCarIcon", label: "Car icon", type: "boolean" },
  ],
  Component: Standings,
};
