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
        // Container-query context so the headline and clock scale with the box
        // width instead of the fixed host font-size — at min size the old fixed
        // `em` headline overflowed and collided with the brand row.
        containerType: "size",
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        color: t.text,
        background: "radial-gradient(120% 130% at 82% 8%, #1c1338 0%, #0b0c10 56%)",
        display: "flex",
        flexDirection: "column",
        padding: "clamp(14px, 5cqw, 30px)",
        boxSizing: "border-box",
        gap: "clamp(12px, 3cqh, 18px)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(135deg, rgba(255,255,255,0.022) 0 2px, transparent 2px 24px)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", left: -70, top: -70, width: 260, height: 260, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,45,142,0.28), transparent 70%)", pointerEvents: "none" }} />

      {/* top row: brand + LIVE */}
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5em" }}>
          <img src="/logo.png" alt="" style={{ width: "clamp(20px, 5cqw, 30px)", height: "clamp(20px, 5cqw, 30px)", borderRadius: 4, flexShrink: 0 }} />
          <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "clamp(15px, 4.4cqw, 26px)", letterSpacing: "0.18em", color: "#fff", lineHeight: 1 }}>TRAILBRAKE</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: "0.64em", height: "0.64em", borderRadius: "50%", background: t.loss, flexShrink: 0 }} />
          <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "clamp(10px, 2.4cqw, 14px)", letterSpacing: "0.14em", color: t.textDim, lineHeight: 1 }}>LIVE</span>
        </div>
      </div>

      {/* headline + countdown — centered in the remaining space */}
      <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 0 }}>
        <div style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "clamp(10px, 2.7cqw, 16px)", letterSpacing: "0.32em", color: t.accent, lineHeight: 1 }}>PLEASE STAND BY</div>
        <div style={{ fontWeight: 700, fontSize: "clamp(30px, 12cqw, 80px)", lineHeight: 0.92, color: "#fff", marginTop: "0.2em", whiteSpace: "nowrap" }}>GRID FORMING</div>
        <div style={{ marginTop: "0.45em", display: "flex", alignItems: "baseline", gap: "0.6em" }}>
          <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "clamp(9px, 2.3cqw, 14px)", letterSpacing: "0.16em", color: t.textDim }}>SESSION STARTS IN</span>
          <span style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "clamp(20px, 5.4cqw, 33px)", color: t.amber, lineHeight: 1 }}>{fmtClock(slow?.timeRemainingS)}</span>
        </div>
      </div>

      {/* footer */}
      {config.showNext && (
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 18, borderTop: `1px solid ${theme.colors.surfaceBorder}`, paddingTop: "clamp(8px, 2.5cqh, 14px)" }}>
          <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "clamp(9px, 2.3cqw, 14px)", letterSpacing: "0.06em", color: t.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>NEXT · {session}{track ? ` · ${track}` : ""}</span>
          <span style={{ marginLeft: "auto", fontFamily: theme.font.mono, fontWeight: 600, fontSize: "clamp(9px, 2.3cqw, 14px)", color: theme.colors.best, flexShrink: 0 }}>@trailbrake</span>
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
