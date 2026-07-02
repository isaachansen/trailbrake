// Chat: a broadcast-chat panel for streamers. Reads from the normalized
// `slow.chatMessages` feed (populated when a chat source is connected). Falls
// back to representative messages when no live chat source exists.

import { useSlow } from "../store/hooks";
import { useScreenLayer } from "../components/screenLayer";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface ChatConfig {
  maxRows: number;
}

const defaultConfig: ChatConfig = { maxRows: 6 };

const DEMO: { user: string; color: string; badge: string | null; text: string }[] = [
  { user: "apex_andy", color: "#2fe08a", badge: null, text: "that overtake into 7 was clean" },
  { user: "turn1_tina", color: "#37d4ea", badge: "MOD", text: "fuel's gonna be tight" },
  { user: "slipstream_sam", color: "#ffb43d", badge: null, text: "P2 incoming let's go" },
];

function Chat({ theme, config }: BaseWidgetProps<ChatConfig>) {
  const t = theme.colors;
  const slow = useSlow();
  const { preview } = useScreenLayer();

  // Keep chronological order (oldest first, newest last) so the feed flows
  // top→bottom like real chat; the list is bottom-anchored below.
  const liveMessages = (slow?.chatMessages ?? []).slice(-config.maxRows);
  // Show DEMO banter only in the manager preview or the mock sim — never on a
  // live overlay where chat is simply not connected.
  const isPreviewOrMock = preview || slow?.sim === "mock";
  const messages = liveMessages.length > 0
    ? liveMessages
    : isPreviewOrMock
      ? DEMO.slice(0, config.maxRows)
      : [];

  const badgeStyle: Record<string, { bg: string; fg: string }> = {
    MOD: { bg: theme.colors.best, fg: "#fff" },
    VIP: { bg: "#ffd23d", fg: "#0a0b0e" },
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ marginBottom: theme.space.sm }}>
        <WidgetTitle title="Chat" theme={theme} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: messages.length === 0 ? "flex-start" : "flex-end", gap: 8 }}>
        {messages.length === 0 ? (
          <span style={{ fontFamily: theme.font.label, fontSize: "0.72em", color: t.textDim2, letterSpacing: "0.04em" }}>No chat connected</span>
        ) : messages.map((m, i) => {
          const badge = m.badge && badgeStyle[m.badge] ? badgeStyle[m.badge] : null;
          return (
            <div key={i} style={{ fontWeight: 500, fontSize: "0.86em", lineHeight: 1.3 }}>
              {badge && (
                <span style={{ display: "inline-block", verticalAlign: "middle", position: "relative", top: "-0.08em", fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.55em", letterSpacing: "0.06em", color: badge.fg, background: badge.bg, padding: "1px 5px", borderRadius: 4, marginRight: 5 }}>{m.badge}</span>
              )}
              <span style={{ color: m.color ?? t.text }}>{m.user}</span>
              <span style={{ color: t.textDim2 }}>: </span>
              <span style={{ color: t.text }}>{m.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const chatDef: WidgetDefinition<ChatConfig> = {
  id: "chat",
  name: "Chat",
  defaultSize: { w: 344, h: 180 },
  minSize: { w: 220, h: 120 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["chat"],
  configSchema: [{ key: "maxRows", label: "Messages", type: "number", min: 3, max: 12, step: 1 }],
  Component: Chat,
};
