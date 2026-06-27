// Standings: rich, optionally multi-class grouped field — position change, car
// number, country flag, driver, license badge, iRating (+delta), gap, interval,
// last/best lap, tyre compound. Slow-path widget.
//
// Columns are built dynamically and a column is dropped entirely when no car can
// fill it, so a sim that doesn't expose (say) tyre or flag data degrades cleanly.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSlow, useCaps } from "../store/hooks";
import { fmtGap, fmtLapTime, hexToRgba } from "./format";
import { flagOf, parseLicense, classColorMap, classColorOf } from "./raceColors";
import { LicenseBadge } from "./LicenseBadge";
import { TyreBadge } from "./TyreBadge";
import { PitBadge } from "./PitBadge";
import { CarIcon, carIconFor, isWideIcon } from "./carIcons";
import type { CarEntry } from "../store/types";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

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
  gapToLeader: number;
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

function Standings({ theme, config, caps }: BaseWidgetProps<StandingsConfig>) {
  const slow = useSlow();
  const capsLive = useCaps() ?? caps;
  const playerIdx = slow?.playerCarIdx ?? null;
  const t = theme.colors;
  const mono = theme.font.mono;

  // Size-aware row budget: measure how many rows actually fit the box (real font
  // px includes the per-widget scale), capped by `maxRows`. Drives how many cars
  // we show across all classes.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const numClassesRef = useRef(1);
  const [fitRows, setFitRows] = useState(99);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const fontPx = parseFloat(getComputedStyle(el).fontSize) || 13;
      const nc = config.multiclass ? numClassesRef.current : 0;
      // Exact per-element heights (em → px) so we only ever fit WHOLE rows:
      //   row 1.9em + 4px margin · column header 1.6em · class header 1.3em + 10px margin.
      const rowH = 1.9 * fontPx + 4;
      const colH = 1.6 * fontPx;
      const classH = nc * (1.3 * fontPx + 10);
      // Root padding (8) + a small safety margin so the last row is never clipped
      // and there's always clean padding at the bottom.
      const fit = Math.max(1, Math.floor((el.clientHeight - 8 - colH - classH - 6) / rowH));
      setFitRows((p) => (p === fit ? p : fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [config.multiclass]);

  let cars = [...(slow?.cars ?? [])].filter((c) => c.inWorld !== false).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  const playerClass = cars.find((c) => c.isPlayer || c.carIdx === playerIdx)?.carClassId ?? null;
  if (config.myClassOnly && playerClass != null) cars = cars.filter((c) => c.carClassId === playerClass);

  // App palette (blue/purple/green/red), assigned by class order — overrides
  // whatever color the sim reports, so classes read consistently.
  const ccol = classColorMap(cars);

  if (cars.length === 0) {
    return <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: t.textDim, fontSize: "0.85em" }}>No field data</div>;
  }

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
        const ic = carIconFor(x.car.carScreenName);
        return ic ? (
          <span style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <CarIcon src={ic} color={x.isPlayer ? "#fff" : t.text} size={isWideIcon(ic) ? "1.63em" : "1.5em"} />
          </span>
        ) : (
          <span />
        );
      },
    });
  if (has.num) cols.push({ id: "num", w: "2.3em", head: "#", align: "r", cell: (x) => numCell("#" + x.car.carNumber, t.textDim) });
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
  cols.push({ id: "gap", w: "minmax(2.9em,1fr)", head: "GAP", align: "r", cell: (x) => numCell(x.isFirst ? "—" : fmtGap(x.gapToLeader), t.text) });
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
    g.rows.push({ car, pos: null, gapToLeader: 0, interval: null, isFirst: false, isPlayer: car.isPlayer || car.carIdx === playerIdx, fastest: false });
  };
  cars.forEach(pushCar);

  // Label each class: short name if the sim gives one, else the car model, else
  // an ordinal — so multiclass always shows a meaningful header.
  groups.forEach((g, i) => {
    const named = g.rows.map((r) => r.car.carClassName).find((n) => n && n.trim());
    const model = g.rows.map((r) => r.car.carScreenName).find((m) => m && m.trim());
    g.name = config.multiclass ? named?.trim() || model?.trim() || `Class ${i + 1}` : null;
  });

  // Per-group: leader gap, interval, displayed position.
  for (const g of groups) {
    const leaderGap = Math.max(...g.rows.map((r) => r.car.gapToPlayerS ?? 0));
    let prev = 0;
    g.rows.forEach((r, i) => {
      r.gapToLeader = leaderGap - (r.car.gapToPlayerS ?? 0);
      r.interval = i === 0 ? null : r.gapToLeader - prev;
      r.isFirst = i === 0;
      r.pos = config.multiclass ? r.car.classPosition ?? r.car.position : r.car.position;
      prev = r.gapToLeader;
    });
  }

  // Distribute the row budget across classes so all classes stay visible, and the
  // surplus goes to the player's own class. The budget tracks the box height.
  numClassesRef.current = groups.length;
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

  return (
    <div ref={rootRef} style={{ width: "100%", height: "100%", overflow: "hidden", color: t.text, padding: "4px 5px", boxSizing: "border-box", fontSize: "0.92em" }}>
      {header}
      {groups.map((g) => (
        <div key={g.id ?? "all"}>
          {config.multiclass && g.name && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: `0 ${PADX}`, margin: "7px 0 3px", height: "1.3em", boxSizing: "content-box" }}>
              <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.74em", letterSpacing: "0.04em", color: "#0a0b0e", padding: "1px 7px", borderRadius: 5, background: classColorOf(ccol, g.id) }}>{g.name}</span>
              <span style={{ fontFamily: theme.font.label, marginLeft: "auto", fontSize: "0.68em", color: t.text, letterSpacing: "0.06em", fontWeight: 800, fontVariantNumeric: "tabular-nums", opacity: 0.92 }}>
                {g.display.length < g.rows.length ? `${g.display.length} OF ${g.rows.length}` : `${g.rows.length} CARS`}
              </span>
            </div>
          )}
          {g.display.map((x) => (
            <div
              key={x.car.carIdx}
              style={{
                display: "grid",
                gridTemplateColumns: template,
                gap: COLGAP,
                alignItems: "center",
                height: "1.9em",
                padding: `0 ${PADX}`,
                margin: "2px 0",
                borderRadius: 8,
                background: x.isPlayer ? "rgba(255, 45, 142, 0.32)" : hexToRgba(classColorOf(ccol, x.car.carClassId), 0.16),
                boxShadow: x.isPlayer ? `inset 0 0 0 1.5px ${t.accent}` : "none",
                color: x.isPlayer ? "#fff" : t.textDim,
                fontWeight: x.isPlayer ? 800 : 500,
                // In the pits → dim the row so it reads as "out of the running".
                opacity: x.car.onPitRoad === true && !x.isPlayer ? 0.72 : 1,
              }}
            >
              {cols.map((c) => <div key={c.id} style={{ minWidth: 0, textAlign: ta(c.align) }}>{c.cell(x)}</div>)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export const standingsDef: WidgetDefinition<StandingsConfig> = {
  id: "standings",
  name: "Standings",
  defaultSize: { w: 620, h: 360 },
  minSize: { w: 320, h: 140 },
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
