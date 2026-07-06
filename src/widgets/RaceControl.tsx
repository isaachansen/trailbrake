// Race control: a feed of officials' messages — flags, penalties, info. Reads
// from the normalized `slow.messages` feed (populated by the connector from flag
// changes) and derives the current status chip from the sim-neutral `slow.flag`.
// Falls back to representative entries when no live messages exist yet.

import { useSlow } from "../store/hooks";
import { useScreenLayer } from "../components/screenLayer";
import type { FlagName } from "../store/types";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface RaceControlConfig {
  maxRows: number;
}

const defaultConfig: RaceControlConfig = { maxRows: 5 };

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

// Mirrors the original bit-tested chip table exactly (which never surfaced a
// chip for debris — only Flag.tsx handled that flag) so iRacing output is
// unchanged. Priority is handled upstream by the backend's FlagState decode.
const STATUS_CHIP: Partial<Record<FlagName, { label: string; color: string }>> = {
  red: { label: "RED", color: "#ff495e" },
  checkered: { label: "CHECKER", color: "#eef1f5" },
  black: { label: "BLACK", color: "#ff495e" },
  yellow: { label: "YELLOW", color: "#ffb43d" },
  white: { label: "WHITE", color: "#eef1f5" },
  blue: { label: "BLUE", color: "#3d8bff" },
  green: { label: "GREEN", color: "#2fe08a" },
};

function deriveStatusChip(flag: FlagName | null | undefined): { label: string; color: string } | null {
  if (flag == null || flag === "none") return null;
  return STATUS_CHIP[flag] ?? null;
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
  const chip = deriveStatusChip(slow?.flag);

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
