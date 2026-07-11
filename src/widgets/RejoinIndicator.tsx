import { useEffect, useRef, useSyncExternalStore } from "react";
import { useStoreInstance } from "../store/storeContext";
import { useScreenLayer } from "../components/screenLayer";
import { editModeStore } from "../store/editMode";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface RejoinConfig {
  careGapS: number;
  stopGapS: number;
}

const defaultConfig: RejoinConfig = {
  careGapS: 3.0,
  stopGapS: 1.5,
};

function RejoinIndicator({ theme, config }: BaseWidgetProps<RejoinConfig>) {
  const t = theme.colors;
  const store = useStoreInstance();
  const editing = useSyncExternalStore(editModeStore.subscribe, editModeStore.get);
  const { preview } = useScreenLayer();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const gapRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ config, editing, preview });
  live.current = { config, editing, preview };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { config, editing, preview } = live.current;
      const slow = store.getSlow();
      const playerIdx = slow?.playerCarIdx ?? null;
      // Honest off-track: TrackSurface == OffTrack. Never invent from low speed.
      const offTrack = slow?.offTrack === true;
      const forceShow = editing || preview;
      const active = offTrack || forceShow;

      let color = t.gain;
      let label = "CLEAR";
      let gapText = "--";

      if (offTrack || forceShow) {
        let nearestBehindGap: number | null = null;
        for (const c of slow?.cars ?? []) {
          if (c.inWorld === false || c.isPlayer || c.carIdx === playerIdx) continue;
          if (c.onPitRoad === true) continue;
          const gap = c.gapToPlayerS;
          if (gap != null && gap < 0) {
            if (nearestBehindGap == null || Math.abs(gap) < Math.abs(nearestBehindGap)) {
              nearestBehindGap = Math.abs(gap);
            }
          }
        }
        if (nearestBehindGap == null) {
          color = t.gain;
          label = "CLEAR";
        } else {
          gapText = nearestBehindGap.toFixed(1) + "s";
          if (nearestBehindGap < config.stopGapS) {
            color = t.loss;
            label = "DO NOT REJOIN";
          } else if (nearestBehindGap < config.careGapS) {
            color = t.amber;
            label = "CAUTION";
          } else {
            color = t.gain;
            label = "CLEAR";
          }
        }
      }

      if (rootRef.current) {
        rootRef.current.style.opacity = active ? "1" : "0";
        rootRef.current.style.visibility = active ? "visible" : "hidden";
      }
      if (statusRef.current) {
        statusRef.current.style.background = color;
        statusRef.current.style.boxShadow = `0 0 10px ${color}99`;
      }
      if (labelRef.current) {
        labelRef.current.textContent = label;
        labelRef.current.style.color = color;
      }
      if (gapRef.current) gapRef.current.textContent = gapText;

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [store, t]);

  // Vanish entirely on the live overlay when on-track; edit/preview keep a shell.
  const slow = store.getSlow();
  if (slow?.offTrack !== true && !editing && !preview) return null;

  const selfPanel = !editing && !preview;

  return (
    <div
      ref={rootRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.9em",
        color: t.text,
        boxSizing: "border-box",
        padding: theme.widgetPad,
        ...(selfPanel
          ? {
              background: t.surface,
              border: `1px solid ${t.surfaceBorder}`,
              borderRadius: theme.radius,
              backdropFilter: theme.panelBlur,
              WebkitBackdropFilter: theme.panelBlur,
              boxShadow: theme.panelShadow,
            }
          : null),
      }}
    >
      <div ref={statusRef} style={{ width: "0.42em", height: "3.5em", borderRadius: "0.21em", background: t.gain, flexShrink: 0, boxShadow: `0 0 10px ${t.gain}99` }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.18em" }}>
        <div ref={labelRef} style={{ fontFamily: theme.font.label, fontWeight: 800, fontSize: "1.1em", letterSpacing: "0.08em", color: t.gain, lineHeight: 1 }}>
          CLEAR
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.4em" }}>
          <span ref={gapRef} style={{ fontFamily: theme.font.mono, fontWeight: 700, fontSize: "1.6em", color: t.text, lineHeight: 1 }}>
            --
          </span>
          <span style={{ fontFamily: theme.font.label, fontSize: "0.6em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim }}>GAP BEHIND</span>
        </div>
      </div>
    </div>
  );
}

export const rejoinDef: WidgetDefinition<RejoinConfig> = {
  id: "rejoin-indicator",
  name: "Rejoin Indicator",
  defaultSize: { w: 260, h: 120 },
  minSize: { w: 200, h: 90 },
  defaultConfig,
  requiredPaths: ["slow", "fast"],
  requiredCapabilities: ["relativeGaps"],
  configSchema: [
    { key: "careGapS", label: "Caution gap (s)", type: "number", min: 0.5, max: 10, step: 0.5 },
    { key: "stopGapS", label: "Stop gap (s)", type: "number", min: 0.3, max: 5, step: 0.3 },
  ],
  // Hides when on-track; host must not leave empty chrome behind.
  transparentPanel: () => true,
  Component: RejoinIndicator,
};
