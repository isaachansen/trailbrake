// Race control: a feed of officials' messages — flags, penalties, info. Reads
// from the normalized `slow.messages` feed (populated by the connector from flag
// changes) and derives the current status chip from `slow.flagsRaw`. Falls back
// to representative entries when no live messages exist yet.

import { useSlow } from "../store/hooks";
import { useScreenLayer } from "../components/screenLayer";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface RaceControlConfig {
  maxRows: number;
}

const defaultConfig: RaceControlConfig = { maxRows: 5 };

// iRacing `irsdk_Flags` bitfield — must match Flag.tsx exactly.
const F_CHECKERED      = 0x00000001;
const F_WHITE          = 0x00000002;
const F_GREEN          = 0x00000004;
const F_YELLOW         = 0x00000008;
const F_RED            = 0x00000010;
const F_BLUE           = 0x00000020;
const F_YELLOW_WAVING  = 0x00000100;
const F_CAUTION        = 0x00004000;
const F_CAUTION_WAVING = 0x00008000;
const F_BLACK          = 0x00010000;

// Combined yellow family (any of these lights the yellow chip).
const F_ANY_YELLOW = F_YELLOW | F_YELLOW_WAVING | F_CAUTION | F_CAUTION_WAVING;

type Tag = "BLUE" | "PEN" | "INFO" | "YEL" | "GREEN" | "RED" | "WHITE" | "CHECKER";
interface Msg {
  time: string;
  tag: Tag;
  text: string;
}

function kindToTag(kind: string): Tag {
  if (kind === "penalty") return "PEN";
  if (kind === "warning") return "YEL";
  if (kind === "flag") {
    return "INFO"; // the specific flag is in the text; status chip shows the live flag
  }
  return "INFO";
}

function fmtTime(s: number | null): string {
  if (s == null || s < 0) return "--:--";
  const total = Math.floor(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function deriveStatusChip(flagsRaw: number | null): { label: string; color: string } | null {
  if (flagsRaw == null || flagsRaw === 0) return null;
  // Priority mirrors Flag.tsx: red > checkered > black > yellow family > white > blue > green.
  if (flagsRaw & F_RED)        return { label: "RED",     color: "#ff495e" };
  if (flagsRaw & F_CHECKERED)  return { label: "CHECKER", color: "#eef1f5" };
  if (flagsRaw & F_BLACK)      return { label: "BLACK",   color: "#ff495e" };
  if (flagsRaw & F_ANY_YELLOW) return { label: "YELLOW",  color: "#ffb43d" };
  if (flagsRaw & F_WHITE)      return { label: "WHITE",   color: "#eef1f5" };
  if (flagsRaw & F_BLUE)       return { label: "BLUE",    color: "#3d8bff" };
  if (flagsRaw & F_GREEN)      return { label: "GREEN",   color: "#2fe08a" };
  return null;
}

// Representative feed for preview/mock, oldest first (matches the live-message
// ordering) so bottom-anchoring shows the "latest" entry at the bottom just
// like it would with real messages. Never shown on a live overlay where race
// control is simply not connected — see `isPreviewOrMock` below.
const DEMO: Msg[] = [
  { time: "18:32", tag: "GREEN", text: "Green flag — racing" },
  { time: "14:07", tag: "YEL", text: "Caution: incident at Turn 4" },
  { time: "9:51", tag: "INFO", text: "Fastest lap: #92 — 1:45.51" },
  { time: "3:20", tag: "PEN", text: "Car #17 — drive-through penalty, contact" },
];

function RaceControl({ theme, config }: BaseWidgetProps<RaceControlConfig>) {
  const t = theme.colors;
  const slow = useSlow();
  const { preview } = useScreenLayer();

  // Keep chronological order (oldest first, newest last) so the feed flows
  // top→bottom like real chat; the list is bottom-anchored below.
  const liveMessages: Msg[] = (slow?.messages ?? [])
    .slice(-config.maxRows)
    .map((m) => ({
      time: fmtTime(m.timeS ?? null),
      tag: kindToTag(m.kind),
      text: m.text,
    }));

  // Show DEMO entries only in the manager preview or the mock sim — never on a
  // live overlay where race control is simply not connected.
  const isPreviewOrMock = preview || slow?.sim === "mock";
  const messages = liveMessages.length > 0
    ? liveMessages
    : isPreviewOrMock
      ? DEMO.slice(-config.maxRows)
      : [];
  const chip = deriveStatusChip(slow?.flagsRaw ?? null);

  const tagStyle: Record<Tag, { color: string; chip: string; chipText: string }> = {
    BLUE: { color: "#3d8bff", chip: "#3d8bff", chipText: "#0a0b0e" },
    PEN: { color: t.loss, chip: t.loss, chipText: "#0a0b0e" },
    YEL: { color: t.amber, chip: t.amber, chipText: "#0a0b0e" },
    INFO: { color: t.textDim2, chip: "transparent", chipText: t.textDim },
    GREEN: { color: t.gain, chip: t.gain, chipText: "#0a0b0e" },
    RED: { color: t.loss, chip: t.loss, chipText: "#0a0b0e" },
    WHITE: { color: "#eef1f5", chip: "#eef1f5", chipText: "#0a0b0e" },
    CHECKER: { color: "#eef1f5", chip: "#eef1f5", chipText: "#0a0b0e" },
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: theme.space.sm }}>
        <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>RACE CONTROL</span>
        {chip && (
          <span style={{ fontFamily: theme.font.label, marginLeft: "auto", fontWeight: 700, fontSize: "0.6em", letterSpacing: "0.1em", color: "#0a0b0e", background: chip.color, padding: "1px 9px", borderRadius: 5 }}>{chip.label}</span>
        )}
      </div>
      {messages.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontFamily: theme.font.label, fontSize: "0.72em", color: t.textDim2, letterSpacing: "0.04em" }}>Waiting for race control…</span>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 5 }}>
          {messages.map((m, i) => {
            const ts = tagStyle[m.tag];
            const info = m.tag === "INFO";
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", background: info ? t.cell : `${ts.color}1a`, borderRadius: 8, borderLeft: `3px solid ${ts.color}` }}>
                <span style={{ fontFamily: theme.font.mono, fontWeight: 500, fontSize: "0.58em", color: t.textDim2, flex: "0 0 auto", whiteSpace: "nowrap" }}>{m.time}</span>
                <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.52em", letterSpacing: "0.06em", color: info ? t.textDim : ts.chipText, background: ts.chip, padding: info ? 0 : "1px 6px", borderRadius: 4, minWidth: "2.6em", textAlign: "center" }}>{m.tag}</span>
                <span style={{ fontWeight: 500, fontSize: "0.72em", color: info ? t.textDim : t.text, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const raceControlDef: WidgetDefinition<RaceControlConfig> = {
  id: "racecontrol",
  name: "Race Control",
  // Work in progress — hidden from the catalog in release builds (see contract).
  draft: true,
  defaultSize: { w: 392, h: 220 },
  minSize: { w: 260, h: 120 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["raceControl"],
  configSchema: [{ key: "maxRows", label: "Rows", type: "number", min: 2, max: 8, step: 1 }],
  Component: RaceControl,
};
