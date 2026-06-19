// Toggleable perf HUD (perf non-negotiable #7). Verifies we're meeting targets:
//
//   reader  — poll rate reported by the backend (sim/mock data rate)
//   push    — telemetry events/sec actually reaching the webview
//   graph   — the Input graph's rAF render rate
//
// It reads the store directly on a low-frequency timer (4 Hz) — it must not
// itself re-render at 60 Hz.

import { useEffect, useState } from "react";
import { store } from "../store/store";
import type { Theme } from "../theme/theme";

interface Props {
  theme: Theme;
}

export function PerfHud({ theme }: Props) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  const readerHz = store.latestFast?.readerHz ?? 0;
  const pushHz = store.pushHz();
  const graphFps = store.graphFps;

  const row = (label: string, value: string, ok: boolean) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
      <span style={{ color: theme.colors.textDim }}>{label}</span>
      <span style={{ color: ok ? theme.colors.gain : theme.colors.loss, fontFamily: theme.font.mono, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );

  return (
    <div
      style={{
        position: "absolute",
        bottom: 8,
        right: 8,
        padding: "6px 10px",
        background: "rgba(0,0,0,0.55)",
        border: `1px solid ${theme.colors.surfaceBorder}`,
        borderRadius: theme.radius,
        font: `600 11px ${theme.font.family}`,
        color: theme.colors.text,
        minWidth: 130,
        pointerEvents: "none",
      }}
    >
      <div style={{ color: theme.colors.textDim, marginBottom: 3, letterSpacing: 0.5 }}>PERF</div>
      {row("reader", `${readerHz.toFixed(0)} Hz`, readerHz >= 30)}
      {row("push", `${pushHz.toFixed(0)} Hz`, pushHz >= 30)}
      {row("graph", `${graphFps.toFixed(0)} fps`, graphFps >= 30)}
    </div>
  );
}
