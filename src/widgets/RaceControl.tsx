// Race control: a feed of officials' messages — flags, penalties, info. The sim
// doesn't yet surface a parsed message feed through our model, so this is gated
// behind the `raceControl` capability (mock/replay only) and shows representative
// entries until a connector fills it. When live sims can't provide it, the widget
// hides rather than inventing messages.

import { useSlow } from "../store/hooks";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface RaceControlConfig {
  maxRows: number;
}

const defaultConfig: RaceControlConfig = { maxRows: 5 };

type Tag = "BLUE" | "PEN" | "INFO" | "YEL" | "GREEN";
interface Msg {
  time: string;
  tag: Tag;
  text: string;
}

// Representative feed (shown only where `raceControl` is available, i.e. mock).
const DEMO: Msg[] = [
  { time: "14:32", tag: "BLUE", text: "#6 — blue flag, GTP closing" },
  { time: "14:30", tag: "PEN", text: "#22 — 5s penalty · track limits" },
  { time: "14:27", tag: "INFO", text: "Fastest lap #92 — 1:45.51" },
  { time: "14:21", tag: "YEL", text: "Yellow S2 — #59 off at turn 7" },
  { time: "14:18", tag: "INFO", text: "Pit window now open" },
];

function RaceControl({ theme, config }: BaseWidgetProps<RaceControlConfig>) {
  const t = theme.colors;
  // Touch the slow store so the widget lives on the same data path it will use
  // once a real feed exists.
  useSlow();

  const tagStyle: Record<Tag, { color: string; chip: string; chipText: string }> = {
    BLUE: { color: "#3d8bff", chip: "#3d8bff", chipText: "#0a0b0e" },
    PEN: { color: t.loss, chip: t.loss, chipText: "#0a0b0e" },
    YEL: { color: t.amber, chip: t.amber, chipText: "#0a0b0e" },
    INFO: { color: t.textDim2, chip: "transparent", chipText: t.textDim },
    GREEN: { color: t.gain, chip: t.gain, chipText: "#0a0b0e" },
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "8px 0 10px", boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px 8px" }}>
        <span style={{ fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>RACE CONTROL</span>
        <span style={{ marginLeft: "auto", fontWeight: 700, fontSize: "0.6em", letterSpacing: "0.1em", color: "#0a0b0e", background: t.gain, padding: "1px 9px", borderRadius: 5 }}>GREEN</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "0 12px", display: "flex", flexDirection: "column", gap: 5 }}>
        {DEMO.slice(0, config.maxRows).map((m, i) => {
          const ts = tagStyle[m.tag];
          const info = m.tag === "INFO";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", background: info ? t.cell : `${ts.color}1a`, borderRadius: 8, borderLeft: `3px solid ${ts.color}` }}>
              <span style={{ fontFamily: theme.font.mono, fontWeight: 500, fontSize: "0.58em", color: t.textDim2, width: "2.6em" }}>{m.time}</span>
              <span style={{ fontWeight: 700, fontSize: "0.52em", letterSpacing: "0.06em", color: info ? t.textDim : ts.chipText, background: ts.chip, padding: info ? 0 : "1px 6px", borderRadius: 4, minWidth: "2.6em", textAlign: "center" }}>{m.tag}</span>
              <span style={{ fontWeight: 500, fontSize: "0.72em", color: info ? t.textDim : t.text, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const raceControlDef: WidgetDefinition<RaceControlConfig> = {
  id: "racecontrol",
  name: "Race Control",
  defaultSize: { w: 392, h: 220 },
  minSize: { w: 260, h: 120 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["raceControl"],
  configSchema: [{ key: "maxRows", label: "Rows", type: "number", min: 2, max: 8, step: 1 }],
  Component: RaceControl,
};
