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

import { useEffect, useRef, useState } from "react";
import { useSlow } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { fmtGap, fmtLapTime, fmtDelta, hexToRgba, fuelValue, fuelLabel, type UnitSystem } from "./format";
import { flagOf, parseLicense, classColorMap, classColorOf } from "./raceColors";
import { LicenseBadge } from "./LicenseBadge";
import { TyreBadge } from "./TyreBadge";
import { CarIcon, carIconFor, isWideIcon } from "./carIcons";
import type { CarEntry, SlowSample } from "../store/types";
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

/** Classify the sim's `sessionType` string into a coarse race/qualy/practice. */
export function classifySessionType(s: string | null | undefined): SessionType | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("qual")) return "qualy";
  if (t.includes("race")) return "race";
  if (t.includes("practice") || t.includes("warmup") || t.includes("test") || t.includes("lone") || t.includes("open"))
    return "practice";
  return null;
}

const INFO_FIELDS: InfoFieldDef[] = [
  { key: "sessionType", label: "Session", render: (s) => (s?.sessionType ? (classifySessionType(s.sessionType) ?? s.sessionType).toUpperCase() : null) },
  { key: "track", label: "Track", render: (s) => s?.trackName ?? null },
  { key: "position", label: "Pos", render: (s) => (s?.position != null ? `P${s.position}` : null) },
  { key: "classPosition", label: "Class", render: (s) => (s?.classPosition != null ? `P${s.classPosition}` : null) },
  { key: "timeLeft", label: "Time", render: (s) => fmtClock(s?.timeRemainingS) },
  { key: "lapsLeft", label: "Laps", render: (s) => (s?.lapsRemaining != null ? `${s.lapsRemaining}` : null) },
  { key: "lap", label: "Lap", render: (s) => (s?.lap != null ? `${s.lap}` : null) },
  { key: "last", label: "Last", render: (s) => (s?.lastLapS != null ? fmtLapTime(s.lastLapS) : null) },
  { key: "best", label: "Best", render: (s) => (s?.bestLapS != null ? fmtLapTime(s.bestLapS) : null) },
  { key: "deltaBest", label: "Δ best", render: (s) => (s?.deltaBestS != null ? fmtDelta(s.deltaBestS) : null) },
  { key: "deltaSess", label: "Δ sess", render: (s) => (s?.deltaSessionBestS != null ? fmtDelta(s.deltaSessionBestS) : null) },
  { key: "fuel", label: "Fuel", render: (s, u) => (s?.fuelL != null ? `${fuelValue(s.fuelL, u)!.toFixed(1)}${fuelLabel(u)}` : null) },
  { key: "fuelPerLap", label: "Fuel/lap", render: (s, u) => (s?.fuelPerLapL != null ? `${fuelValue(s.fuelPerLapL, u)!.toFixed(2)}${fuelLabel(u)}` : null) },
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
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0.45em 0.9em", padding: "0 0.6em", fontSize: "0.7em" }}>
      {chips.map(({ def, value }) => (
        <span key={def.key} style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: dim, letterSpacing: "0.04em", marginRight: "0.45em" }}>{def.label}</span>
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
  const cars = slow?.cars ?? [];
  const playerIdx = slow?.playerCarIdx ?? null;
  const ccol = classColorMap(cars); // app palette by class order (blue/purple/green/red)
  const curSession = classifySessionType(slow?.sessionType);
  const units = useSettings().units;

  const headerChips = visibleChips(config.header, slow, curSession, units);
  const footerChips = visibleChips(config.footer, slow, curSession, units);

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
  const ordered = cars
    .filter((c) => c.gapToPlayerS != null || c.isPlayer || c.carIdx === playerIdx)
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
        <span style={{ fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>RELATIVE</span>
        <span style={{ marginLeft: "auto", fontSize: "0.62em", color: t.textDim2, letterSpacing: "0.06em" }}>±{config.windowSeconds}s</span>
      </div>

      {headerChips.length > 0 && (
        <div style={{ paddingBottom: 5, marginBottom: 4, borderBottom: `1px solid ${hexToRgba("#ffffff", 0.07)}` }}>
          <InfoBar chips={headerChips} color={t.text} dim={t.textDim2} mono={mono} />
        </div>
      )}

      <div ref={rowsRef} style={{ position: "relative", flex: 1, minHeight: visible.length ? `${visible.length * ROWH}em` : 0 }}>
        {visible.length === 0 ? (
          <div style={{ textAlign: "center", color: t.textDim, fontSize: "0.82em", paddingTop: "0.6em" }}>No field data</div>
        ) : (
          visible.map((c, slot) => {
            const isPlayer = c.isPlayer || c.carIdx === playerIdx;
            const gap = c.gapToPlayerS ?? 0;
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
                  gap: "0.5em",
                  padding: "0 0.6em",
                  borderRadius: 9,
                  background: isPlayer ? "rgba(255, 45, 142, 0.32)" : hexToRgba(classColorOf(ccol, c.carClassId), 0.18),
                  boxShadow: isPlayer ? `inset 0 0 0 1.5px ${t.accent}` : "none",
                  color: isPlayer ? "#fff" : t.textDim,
                  fontWeight: isPlayer ? 800 : 500,
                  transition: "top 0.35s cubic-bezier(.4,0,.2,1), background 0.2s",
                }}
              >
                {(c.classPosition ?? c.position) == null ? (
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
                      fontWeight: isPlayer ? 800 : 700,
                      color: isPlayer ? "#fff" : t.text,
                    }}
                  >
                    {c.classPosition ?? c.position}
                  </span>
                )}
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
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: has.car ? "0.45em" : undefined, color: isPlayer ? "#fff" : t.text }}>
                  {c.driverName ?? `Car ${c.carIdx}`}
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
        <div style={{ paddingTop: 5, marginTop: 4, borderTop: `1px solid ${hexToRgba("#ffffff", 0.07)}` }}>
          <InfoBar chips={footerChips} color={t.text} dim={t.textDim2} mono={mono} />
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
    { key: "header", label: "Header", type: "fieldList", fields: RELATIVE_INFO_CATALOG },
    { key: "footer", label: "Footer", type: "fieldList", fields: RELATIVE_INFO_CATALOG },
  ],
  Component: Relative,
};
