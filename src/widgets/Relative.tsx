// Relative: the cars immediately around you by track-time, ahead and behind, with
// flag, license, iRating, tyre and the relative gap. Slow-path widget.
//
// Two things make it readable at a glance:
//  - rows are sorted by relative gap (ahead at top, you in the middle, behind at
//    the bottom) and filtered to a time window so distant cars drop off;
//  - rows are absolutely positioned by slot and transition their `top`, so when an
//    overtake changes the order the two cars visibly slide past each other.
//
// Above and below the rows sit an optional header / footer info bar: a
// reorderable, per-session-type-toggleable set of telemetry fields (session,
// position, lap times, fuel, …) configured from the settings panel.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { fmtGap, fmtLapTime, fmtDelta, hexToRgba, fuelValue, fuelLabel, tempValue, tempLabel, type UnitSystem } from "./format";
import { InfoIcon } from "./relativeInfoIcons";
import { flagOf, parseLicense, classColorMap, classColorOf } from "./raceColors";
import { LicenseBadge } from "./LicenseBadge";
import { TyreBadge } from "./TyreBadge";
import { PitBadge } from "./PitBadge";
import { CarIcon, carIconFor, isWideIcon } from "./carIcons";
import type { CarEntry, SlowSample } from "../store/types";
import { classifySessionType } from "./contract";
import type { BaseWidgetProps, InfoFieldConfig, SessionType, WidgetDefinition } from "./contract";

export interface RelativeConfig {
  rowsAhead: number;
  rowsBehind: number;
  /** Hide cars more than this many seconds ahead/behind. */
  windowSeconds: number;
  showFlag: boolean;
  showLicense: boolean;
  showIrating: boolean;
  showTyre: boolean;
  showCarIcon: boolean;
  /** In qualifying, show only the player (you're on a solo hot lap — no field). */
  soloInQualy: boolean;
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
  rowsAhead: 4,
  rowsBehind: 4,
  windowSeconds: 30,
  showFlag: true,
  showLicense: true,
  showIrating: true,
  showTyre: true,
  showCarIcon: true,
  soloInQualy: true,
  header: buildFieldDefaults(["sessionType", "position", "timeLeft"]),
  footer: buildFieldDefaults(["last", "best", "fuel"]),
};

const ROWH = 2.25; // em — slot height; rows animate their `top` between slots.

/** The chips to show for one info bar, given the current session category. */
function visibleChips(entries: InfoFieldConfig[] | undefined, slow: SlowSample | null, cur: SessionType | null, units: UnitSystem) {
  return (entries ?? [])
    .filter((e) => e.on && (cur == null || e.sessions.includes(cur)))
    .map((e) => ({ def: FIELD_MAP[e.key], value: FIELD_MAP[e.key]?.render(slow, units) ?? null }))
    .filter((x): x is { def: InfoFieldDef; value: string } => x.def != null && x.value != null);
}

function InfoBar({ chips, color, dim, mono }: { chips: { def: InfoFieldDef; value: string }[]; color: string; dim: string; mono: string }) {
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.45em 0.9em", padding: "0 0.6em", fontSize: "0.7em" }}>
      {chips.map(({ def, value }) => (
        <span key={def.key} title={def.label} style={{ display: "inline-flex", alignItems: "center", gap: "0.42em", whiteSpace: "nowrap" }}>
          <span style={{ color: dim, display: "inline-flex" }}><InfoIcon name={def.key} /></span>
          <span style={{ color, fontFamily: mono, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </span>
      ))}
    </div>
  );
}

function Relative({ theme, config }: BaseWidgetProps<RelativeConfig>) {
  const t = theme.colors;
  const mono = theme.font.mono;
  const slow = useSlow();
  const playerIdx = slow?.playerCarIdx ?? null;
  const curSession = classifySessionType(slow?.sessionType);
  // In qualifying you run a solo hot lap, so the field is just noise — show only
  // the player when `soloInQualy` is on.
  const soloQualy = config.soloInQualy && curSession === "qualy";
  const cars = (slow?.cars ?? []).filter((c) => !soloQualy || c.isPlayer || c.carIdx === playerIdx);
  const ccol = classColorMap(cars); // app palette by class order (blue/purple/green/red)
  const units = useSettings().units;

  // Provisional grid position. Before anyone sets a time (practice / pre-qualify)
  // iRacing reports no running position, so the badge would otherwise read "--".
  // iRacing seeds the starting order by iRating, so we reproduce that: rank the
  // field by iRating (descending), both overall and within class, and use it only
  // as a fallback — a real position from the sim always wins once it exists.
  const { provPos, provClassPos } = useMemo(() => {
    const rated = (slow?.cars ?? []).filter((c) => c.irating != null);
    const provPos = new Map<number, number>();
    [...rated]
      .sort((a, b) => (b.irating ?? 0) - (a.irating ?? 0))
      .forEach((c, i) => provPos.set(c.carIdx, i + 1));
    const provClassPos = new Map<number, number>();
    const byClass = new Map<number, CarEntry[]>();
    for (const c of rated) {
      const k = c.carClassId ?? 0;
      let g = byClass.get(k);
      if (!g) { g = []; byClass.set(k, g); }
      g.push(c);
    }
    for (const g of byClass.values()) {
      g.sort((a, b) => (b.irating ?? 0) - (a.irating ?? 0));
      g.forEach((c, i) => provClassPos.set(c.carIdx, i + 1));
    }
    return { provPos, provClassPos };
  }, [slow?.cars]);

  /** A car's shown position: real (class, then overall) first, else the iRating
   *  provisional. Returns the number and whether it's provisional. */
  const posOf = (c: CarEntry): { pos: number | null; provisional: boolean } => {
    const real = c.classPosition ?? c.position;
    if (real != null) return { pos: real, provisional: false };
    const prov = provClassPos.get(c.carIdx) ?? provPos.get(c.carIdx) ?? null;
    return { pos: prov, provisional: prov != null };
  };

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

  // Size-aware fit: measure the rows region (which flex-fills the space left by
  // the header/footer bars) and only ever show whole rows, so the bottom row is
  // never clipped and there's clean padding below it.
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(99);
  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const measure = () => {
      const fontPx = parseFloat(getComputedStyle(el).fontSize) || 13;
      const f = Math.max(1, Math.floor((el.clientHeight - 2) / (ROWH * fontPx)));
      setFit((p) => (p === f ? p : f));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  // Window: drop cars beyond ±windowSeconds (the player always stays).
  const inWindow = ordered.filter(
    (c) => c.isPlayer || c.carIdx === playerIdx || Math.abs(c.gapToPlayerS ?? 0) <= config.windowSeconds
  );
  const wpi = inWindow.findIndex((c) => c.isPlayer || c.carIdx === playerIdx);

  // Trim the configured window down to what actually fits, keeping the player as
  // centered as possible (drop from the larger side first).
  const desired = config.rowsAhead + config.rowsBehind + 1;
  const shown = Math.max(1, Math.min(desired, fit));
  let ahead = config.rowsAhead;
  let behind = config.rowsBehind;
  while (ahead + behind + 1 > shown) {
    if (ahead >= behind) ahead--;
    else behind--;
  }
  let visible: CarEntry[];
  if (wpi >= 0) {
    visible = inWindow.slice(Math.max(0, wpi - ahead), wpi + behind + 1);
  } else {
    visible = inWindow.slice(0, shown);
  }

  const has = {
    flag: config.showFlag && visible.some((c) => c.country),
    car: config.showCarIcon && visible.some((c) => carIconFor(c.carScreenName)),
    lic: config.showLicense && visible.some((c) => c.safetyRating),
    ir: config.showIrating && visible.some((c) => c.irating != null),
    tyre: config.showTyre && visible.some((c) => c.tyre),
  };

  // Grid columns mirror the data we actually have.
  const cols =
    "2em" + // pos
    (has.flag ? " 1.3em" : "") +
    (has.car ? " 2em" : "") + // car icon, just before the name
    " minmax(3em,1fr)" + // name
    (has.lic ? " 4.2em" : "") +
    (has.ir ? " 2.7em" : "") +
    (has.tyre ? " 2em" : "") +
    " 3.1em"; // gap

  return (
    <div style={{ width: "100%", height: "100%", overflow: "hidden", display: "flex", flexDirection: "column", color: t.text, padding: "6px 7px 7px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "0 0.6em 5px" }}>
        <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>RELATIVE</span>
        <span style={{ fontFamily: theme.font.label, marginLeft: "auto", fontSize: "0.62em", color: t.textDim2, letterSpacing: "0.06em" }}>±{config.windowSeconds}s</span>
      </div>

      {headerChips.length > 0 && (
        <div style={{ paddingBottom: 5, marginBottom: 4, borderBottom: `1px solid ${hexToRgba("#ffffff", 0.12)}` }}>
          <InfoBar chips={headerChips} color={t.text} dim={t.textDim} mono={mono} />
        </div>
      )}

      <div ref={rowsRef} style={{ position: "relative", flex: 1, minHeight: visible.length ? `${visible.length * ROWH}em` : 0 }}>
        {visible.length === 0 ? (
          <div style={{ textAlign: "center", color: t.textDim, fontSize: "0.82em", paddingTop: "0.6em" }}>No field data</div>
        ) : (
          visible.map((c, slot) => {
            const isPlayer = c.isPlayer || c.carIdx === playerIdx;
            const gap = c.gapToPlayerS ?? 0;
            const inPit = c.onPitRoad === true;
            const lic = parseLicense(c.safetyRating);
            return (
              <div
                key={c.carIdx}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: `${slot * ROWH}em`,
                  height: `${ROWH - 0.2}em`,
                  display: "grid",
                  gridTemplateColumns: cols,
                  alignItems: "center",
                  gap: "0.8em",
                  padding: "0 0.6em",
                  borderRadius: 8,
                  background: isPlayer ? "rgba(255, 45, 142, 0.32)" : hexToRgba(classColorOf(ccol, c.carClassId), 0.18),
                  boxShadow: isPlayer ? `inset 0 0 0 1.5px ${t.accent}` : "none",
                  color: isPlayer ? "#fff" : t.textDim,
                  fontWeight: isPlayer ? 800 : 500,
                  // In the pits → dim the row so it reads as "not a threat".
                  opacity: inPit && !isPlayer ? 0.7 : 1,
                  transition: "top 0.35s cubic-bezier(.4,0,.2,1), background 0.2s, opacity 0.2s",
                }}
              >
                {(() => {
                  const { pos, provisional } = posOf(c);
                  if (pos == null) return <span style={{ color: t.textDim2 }}>--</span>;
                  return (
                    <span
                      title={provisional ? "Provisional — grid order seeded by iRating (no session position set yet)" : undefined}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        minWidth: "1.55em",
                        height: "1.55em",
                        padding: "0 0.25em",
                        borderRadius: 5,
                        // Real position → solid chip; provisional → outlined + italic
                        // so it reads as a seeded estimate, not a live result.
                        background: provisional ? "transparent" : "rgba(0,0,0,0.28)",
                        boxShadow: provisional ? `inset 0 0 0 1px ${hexToRgba("#ffffff", 0.22)}` : "none",
                        fontVariantNumeric: "tabular-nums",
                        fontStyle: provisional ? "italic" : "normal",
                        fontWeight: isPlayer ? 800 : 700,
                        color: isPlayer ? "#fff" : provisional ? t.textDim : t.text,
                      }}
                    >
                      {pos}
                    </span>
                  );
                })()}
                {has.flag && (
                  <span style={{ justifySelf: "center", display: "inline-block", width: "1.2em", height: "0.82em", borderRadius: 2, background: flagOf(c.country), boxShadow: "inset 0 0 0 1px rgba(0,0,0,.35)" }} />
                )}
                {has.car && (
                  <span style={{ justifySelf: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {(() => {
                      const ic = carIconFor(c.carScreenName);
                      return <CarIcon src={ic} color={isPlayer ? "#fff" : t.text} size={isWideIcon(ic) ? "1.63em" : "1.5em"} />;
                    })()}
                  </span>
                )}
                <span style={{ display: "flex", alignItems: "center", gap: "0.45em", overflow: "hidden", marginLeft: has.car ? "0.65em" : undefined }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isPlayer ? "#fff" : t.text }}>
                    {c.driverName ?? `Car ${c.carIdx}`}
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
                    {c.irating != null ? (c.irating / 1000).toFixed(1) + "k" : "--"}
                  </span>
                )}
                {has.tyre && (
                  <span style={{ justifySelf: "center", alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <TyreBadge compound={c.tyre} />
                  </span>
                )}
                <span style={{ fontFamily: mono, fontWeight: 700, fontVariantNumeric: "tabular-nums", textAlign: "right", color: isPlayer ? "#fff" : gap > 0 ? t.loss : t.gain }}>
                  {isPlayer ? "—" : `${gap > 0 ? "+" : "−"}${fmtGap(gap)}`}
                </span>
              </div>
            );
          })
        )}
      </div>

      {footerChips.length > 0 && (
        <div style={{ paddingTop: 5, marginTop: 4, borderTop: `1px solid ${hexToRgba("#ffffff", 0.12)}` }}>
          <InfoBar chips={footerChips} color={t.text} dim={t.textDim} mono={mono} />
        </div>
      )}
    </div>
  );
}

export const relativeDef: WidgetDefinition<RelativeConfig> = {
  id: "relative",
  name: "Relative",
  defaultSize: { w: 400, h: 250 },
  minSize: { w: 280, h: 110 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [
    { key: "rowsAhead", label: "Rows ahead", type: "number", min: 1, max: 8, step: 1 },
    { key: "rowsBehind", label: "Rows behind", type: "number", min: 1, max: 8, step: 1 },
    { key: "windowSeconds", label: "Window (s)", type: "number", min: 5, max: 60, step: 5 },
    { key: "showFlag", label: "Flags", type: "boolean" },
    { key: "showLicense", label: "License", type: "boolean" },
    { key: "showIrating", label: "iRating", type: "boolean" },
    { key: "showTyre", label: "Tyre", type: "boolean" },
    { key: "showCarIcon", label: "Car icon", type: "boolean" },
    { key: "soloInQualy", label: "Solo in qualy", type: "boolean" },
    { key: "header", label: "Header", type: "fieldList", fields: RELATIVE_INFO_CATALOG },
    { key: "footer", label: "Footer", type: "fieldList", fields: RELATIVE_INFO_CATALOG },
  ],
  Component: Relative,
};
