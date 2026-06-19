// Chat: a broadcast-chat panel for streamers. This is not telemetry — it needs a
// connected chat source (Twitch / YouTube etc.), which is represented by the
// `chat` capability. Until a source is wired, it's available only where `chat` is
// provided (mock/preview) and shows representative messages; on live sims with no
// chat source the widget hides rather than faking a feed.

import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface ChatConfig {
  maxRows: number;
}

const defaultConfig: ChatConfig = { maxRows: 6 };

type Badge = "MOD" | "VIP" | null;
interface ChatMsg {
  user: string;
  color: string;
  badge: Badge;
  text: string;
}

const DEMO: ChatMsg[] = [
  { user: "apex_andy", color: "#2fe08a", badge: null, text: "that overtake into 7 was clean" },
  { user: "turn1_tina", color: "#37d4ea", badge: "MOD", text: "fuel's gonna be tight" },
  { user: "slipstream_sam", color: "#ffb43d", badge: null, text: "P2 incoming let's go" },
  { user: "box_box_bri", color: "#ff2d8e", badge: "VIP", text: "what tyres on the stop?" },
  { user: "downshift_dan", color: "#b06bff", badge: null, text: "that delta is unreal rn" },
  { user: "grid_grace", color: "#2fe08a", badge: null, text: "3 wide into the bus stop omg" },
];

function Chat({ theme, config }: BaseWidgetProps<ChatConfig>) {
  const t = theme.colors;
  const badgeStyle: Record<"MOD" | "VIP", { bg: string; fg: string }> = {
    MOD: { bg: theme.colors.best, fg: "#fff" },
    VIP: { bg: "#ffd23d", fg: "#0a0b0e" },
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: "8px 0 11px", boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px 8px" }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: theme.colors.best }} />
        <span style={{ fontWeight: 700, fontSize: "0.82em", letterSpacing: "0.1em" }}>CHAT</span>
        <span style={{ marginLeft: "auto", fontFamily: theme.font.mono, fontWeight: 600, fontSize: "0.58em", color: t.textDim2 }}>1,284 watching</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "0 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {DEMO.slice(0, config.maxRows).map((m, i) => (
          <div key={i} style={{ fontWeight: 500, fontSize: "0.86em", lineHeight: 1.3 }}>
            {m.badge && (
              <span style={{ fontWeight: 700, fontSize: "0.55em", letterSpacing: "0.06em", color: badgeStyle[m.badge].fg, background: badgeStyle[m.badge].bg, padding: "1px 5px", borderRadius: 4, marginRight: 5 }}>{m.badge}</span>
            )}
            <span style={{ color: m.color }}>{m.user}</span>
            <span style={{ color: t.textDim2 }}>: </span>
            <span style={{ color: t.text }}>{m.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const chatDef: WidgetDefinition<ChatConfig> = {
  id: "chat",
  name: "Chat",
  defaultSize: { w: 344, h: 220 },
  minSize: { w: 220, h: 120 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["chat"],
  configSchema: [{ key: "maxRows", label: "Messages", type: "number", min: 3, max: 12, step: 1 }],
  Component: Chat,
};
