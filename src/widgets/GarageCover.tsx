// Garage cover: a full "please stand by" card for streams — shown while you're in
// the garage / pre-grid (set its "Show overlay when" to In garage). Branded, with
// a live countdown and the upcoming session. Slow-path; uses session info only.

import { useSlow } from "../store/hooks";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface GarageCoverConfig {
  showNext: boolean;
}

const defaultConfig: GarageCoverConfig = { showNext: true };

function fmtClock(s: number | null | undefined): string {
  if (s == null || !isFinite(s) || s < 0) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function GarageCover({ theme, config }: BaseWidgetProps<GarageCoverConfig>) {
  const t = theme.colors;
  const slow = useSlow();
  const track = (slow?.trackName ?? "").toUpperCase();
  const session = (slow?.sessionType ?? "Session").toUpperCase();

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        color: t.text,
        background: "radial-gradient(120% 130% at 82% 8%, #1c1338 0%, #0b0c10 56%)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(135deg, rgba(255,255,255,0.022) 0 2px, transparent 2px 24px)" }} />
      <div style={{ position: "absolute", left: -70, top: -70, width: 260, height: 260, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,45,142,0.28), transparent 70%)" }} />

      {/* top row: brand + LIVE */}
      <div style={{ position: "absolute", top: "1.8em", left: "2.1em", right: "2.1em", display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <img src="/logo.png" alt="" style={{ width: "1.5em", height: "1.5em", borderRadius: 4 }} />
          <span style={{ fontWeight: 700, fontSize: "1.5em", letterSpacing: "0.18em", color: "#fff" }}>TRAILBRAKE</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: "0.64em", height: "0.64em", borderRadius: "50%", background: t.loss }} />
          <span style={{ fontWeight: 600, fontSize: "0.8em", letterSpacing: "0.14em", color: t.textDim }}>LIVE</span>
        </div>
      </div>

      {/* headline + countdown */}
      <div style={{ position: "absolute", left: "2.1em", bottom: config.showNext ? "6em" : "2.2em" }}>
        <div style={{ fontWeight: 600, fontSize: "0.92em", letterSpacing: "0.34em", color: t.accent }}>PLEASE STAND BY</div>
        <div style={{ fontWeight: 700, fontSize: "4.7em", lineHeight: 0.9, color: "#fff", marginTop: 7 }}>GRID FORMING</div>
        <div style={{ marginTop: 15, display: "flex", alignItems: "center", gap: 11 }}>
          <span style={{ fontWeight: 600, fontSize: "0.78em", letterSpacing: "0.16em", color: t.textDim }}>SESSION STARTS IN</span>
          <span style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "1.85em", color: t.amber }}>{fmtClock(slow?.timeRemainingS)}</span>
        </div>
      </div>

      {/* footer */}
      {config.showNext && (
        <div style={{ position: "absolute", left: "2.1em", right: "2.1em", bottom: "1.7em", display: "flex", alignItems: "center", gap: 18, borderTop: `1px solid ${theme.colors.surfaceBorder}`, paddingTop: "1em" }}>
          <span style={{ fontWeight: 600, fontSize: "0.78em", letterSpacing: "0.06em", color: t.textDim }}>NEXT · {session}{track ? ` · ${track}` : ""}</span>
          <span style={{ marginLeft: "auto", fontFamily: theme.font.mono, fontWeight: 600, fontSize: "0.78em", color: theme.colors.best }}>@trailbrake</span>
        </div>
      )}
    </div>
  );
}

export const garageCoverDef: WidgetDefinition<GarageCoverConfig> = {
  id: "garage",
  name: "Garage Cover",
  defaultSize: { w: 620, h: 348 },
  minSize: { w: 340, h: 190 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: [],
  configSchema: [{ key: "showNext", label: "Footer", type: "boolean" }],
  Component: GarageCover,
};
