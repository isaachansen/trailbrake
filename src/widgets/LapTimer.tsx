import { useEffect, useRef } from "react";
import { useStoreInstance } from "../store/storeContext";
import { fmtLapTime, fmtDelta } from "./format";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

/** Deltas beyond this magnitude are out-lap / invalid-lap artefacts. */
const MAX_VALID_DELTA_S = 30;
const validDelta = (d: number | null): number | null =>
  d != null && isFinite(d) && Math.abs(d) <= MAX_VALID_DELTA_S ? d : null;

export interface LapTimerConfig {
  showPredicted: boolean;
  showHistory: boolean;
  showDelta: boolean;
}

const defaultConfig: LapTimerConfig = {
  showPredicted: true,
  showHistory: false,
  showDelta: true,
};

function LapTimer({ theme, config }: BaseWidgetProps<LapTimerConfig>) {
  const store = useStoreInstance();
  const t = theme.colors;
  const mono = theme.font.mono;

  const curRef = useRef<HTMLSpanElement | null>(null);
  const predRef = useRef<HTMLSpanElement | null>(null);
  const bestRef = useRef<HTMLDivElement | null>(null);
  const lastRef = useRef<HTMLDivElement | null>(null);
  const deltaRef = useRef<HTMLSpanElement | null>(null);

  const live = useRef({ theme, config });
  live.current = { theme, config };

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const { theme } = live.current;
      const t = theme.colors;
      const fast = store.latestFast;
      const slow = store.getSlow();

      const cur = fast?.currentLapS ?? slow?.currentLapS ?? null;
      setText(curRef.current, fmtLapTime(cur));

      const deltaBest = slow?.deltaBestS ?? null;
      const deltaSess = slow?.deltaSessionBestS ?? null;
      // Guard against out-lap / invalid-lap spikes before using for display or math.
      const deltaBestValid = validDelta(deltaBest);
      const deltaSessValid = validDelta(deltaSess);
      let curColor = t.text;
      if (deltaSessValid != null && deltaSessValid < 0) curColor = t.best;
      else if (deltaBestValid != null && deltaBestValid < 0) curColor = t.gain;
      setColor(curRef.current, curColor);

      const predicted = cur != null && deltaBestValid != null ? cur + deltaBestValid : null;
      setText(predRef.current, fmtLapTime(predicted));

      setText(bestRef.current, fmtLapTime(slow?.bestLapS ?? null));
      setText(lastRef.current, fmtLapTime(slow?.lastLapS ?? null));

      setText(deltaRef.current, deltaBestValid != null ? fmtDelta(deltaBestValid) : "--");
      setColor(deltaRef.current, deltaBestValid == null ? t.textDim : deltaBestValid < 0 ? t.gain : deltaBestValid > 0 ? t.loss : t.amber);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cell = (label: string, ref: React.RefObject<HTMLDivElement>, initial: string) => (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, padding: "3px 2px", background: t.cell, borderRadius: theme.space.md, minWidth: 0 }}>
      <div style={{ fontFamily: theme.font.label, fontSize: "0.56em", fontWeight: 600, letterSpacing: "0.1em", color: t.textDim2 }}>{label}</div>
      <div ref={ref} style={{ fontFamily: mono, fontWeight: 700, fontSize: "1.02em", lineHeight: 1, color: t.text, fontVariantNumeric: "tabular-nums" }}>{initial}</div>
    </div>
  );

  const stat = (label: string, ref: React.RefObject<HTMLSpanElement>, grow: number) => (
    <div style={{ flex: `${grow} 1 0`, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 3, minWidth: 0 }}>
      <span style={{ fontFamily: theme.font.label, fontWeight: 600, fontSize: "0.55em", letterSpacing: "0.06em", color: t.textDim2, flex: "0 0 auto" }}>{label}</span>
      <span ref={ref} style={{ fontFamily: mono, fontWeight: 700, fontSize: "0.82em", lineHeight: 1, color: t.textDim, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>--</span>
    </div>
  );

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: t.text, padding: theme.widgetPad, boxSizing: "border-box", overflow: "hidden", gap: theme.space.sm }}>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center" }}>
        <span style={{ fontFamily: theme.font.label, fontWeight: 700, fontSize: "0.76em", letterSpacing: "0.12em", color: t.textDim }}>LAP TIMER</span>
      </div>

      <div style={{ flex: "1 1 auto", display: "flex", justifyContent: "center", alignItems: "center", minHeight: 0, overflow: "hidden" }}>
        <span ref={curRef} style={{ fontFamily: mono, fontWeight: 700, fontSize: "2.0em", lineHeight: 1, color: t.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>--</span>
      </div>

      {(config.showPredicted || config.showDelta) && (
        <div style={{ flex: "0 0 auto", display: "flex", gap: theme.space.sm }}>
          {config.showPredicted && stat("PRED", predRef, 7)}
          {config.showDelta && stat("DELTA", deltaRef, 5)}
        </div>
      )}

      <div style={{ flex: "0 0 auto", display: "flex", gap: theme.space.sm }}>
        {cell("BEST", bestRef, "--")}
        {cell("LAST", lastRef, "--")}
      </div>
    </div>
  );
}

export const lapTimerDef: WidgetDefinition<LapTimerConfig> = {
  id: "lap-timer",
  name: "Lap Timer",
  defaultSize: { w: 220, h: 132 },
  minSize: { w: 160, h: 120 },
  defaultConfig,
  requiredPaths: ["slow", "fast"],
  requiredCapabilities: [],
  configSchema: [
    { key: "showPredicted", label: "Predicted lap", type: "boolean" },
    { key: "showDelta", label: "Delta", type: "boolean" },
    { key: "showHistory", label: "Lap history", type: "boolean" },
  ],
  Component: LapTimer,
};

function setText(el: HTMLElement | null, s: string) {
  if (el && el.textContent !== s) el.textContent = s;
}
function setColor(el: HTMLElement | null, c: string) {
  if (el && el.style.color !== c) el.style.color = c;
}
