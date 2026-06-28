import { useRef, useState } from "react";
import { useSlow } from "../store/hooks";
import { WidgetTitle } from "./WidgetTitle";
import type { BaseWidgetProps, WidgetDefinition } from "./contract";

export interface SetupComparisonConfig {
  label: string;
}

const defaultConfig: SetupComparisonConfig = { label: "Snapshot A" };

interface Snapshot {
  label: string;
  time: number;
  brakeBiasPct: number | null;
  absActive: boolean | null;
  tcActive: boolean | null;
  drsState: number | null;
  ersPct: number | null;
  fuelMix: number | null;
  tirePressures: { lfKpa: number | null; rfKpa: number | null; lrKpa: number | null; rrKpa: number | null };
}

function SetupComparison({ theme, config }: BaseWidgetProps<SetupComparisonConfig>) {
  const slow = useSlow();
  const t = theme.colors;
  const mono = theme.font.mono;
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const labelRef = useRef(config.label);

  const capture = () => {
    if (!slow) return;
    const snap: Snapshot = {
      label: labelRef.current || `Snap ${snapshots.length + 1}`,
      time: Date.now(),
      brakeBiasPct: slow.brakeBiasPct ?? null,
      absActive: slow.absActive ?? null,
      tcActive: slow.tcActive ?? null,
      drsState: slow.drsState ?? null,
      ersPct: slow.ersPct ?? null,
      fuelMix: slow.fuelMix ?? null,
      tirePressures: { ...slow.tirePressures },
    };
    setSnapshots((prev) => [...prev, snap]);
  };

  const removeSnap = (idx: number) => setSnapshots((prev) => prev.filter((_, i) => i !== idx));

  // `fmt` shapes each value for display; brake-bias/ERS arrive as 0..1 fractions
  // (shown as whole percent), pressures and discrete modes read as integers.
  const pct = (v: number | null) => (v != null ? `${Math.round(v * 100)}` : "--");
  const int = (v: number | null) => (v != null ? `${Math.round(v)}` : "--");
  const rows: { label: string; get: (s: Snapshot) => number | null; fmt: (v: number | null) => string }[] = [
    { label: "Brake Bias %", get: (s) => s.brakeBiasPct, fmt: pct },
    { label: "LF kPa", get: (s) => s.tirePressures.lfKpa, fmt: int },
    { label: "RF kPa", get: (s) => s.tirePressures.rfKpa, fmt: int },
    { label: "LR kPa", get: (s) => s.tirePressures.lrKpa, fmt: int },
    { label: "RR kPa", get: (s) => s.tirePressures.rrKpa, fmt: int },
    { label: "ERS %", get: (s) => s.ersPct, fmt: pct },
    { label: "Fuel Mix", get: (s) => s.fuelMix, fmt: int },
    { label: "DRS State", get: (s) => s.drsState, fmt: int },
  ];

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px", boxSizing: "border-box", color: t.text, overflow: "hidden" }}>
      <WidgetTitle
        title="Setup Comparison"
        theme={theme}
        right={
          <button
            onClick={capture}
            disabled={!slow}
            style={{
              padding: "3px 12px",
              border: "none",
              borderRadius: 6,
              cursor: slow ? "pointer" : "not-allowed",
              background: t.accent,
              color: "#0a0b0e",
              font: `700 10px ${theme.font.family}`,
              letterSpacing: "0.04em",
              opacity: slow ? 1 : 0.4,
            }}
          >
            + Snapshot
          </button>
        }
      />

      {snapshots.length === 0 ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: t.textDim2, fontSize: "0.7em", fontWeight: 500 }}>
          Capture setup snapshots to compare changes.
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.62em", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "34%" }} />
              {snapshots.map((_, i) => (
                <col key={i} />
              ))}
            </colgroup>
            <thead>
              <tr style={{ borderBottom: `1px solid ${t.surfaceBorder}` }}>
                <th style={{ textAlign: "left", padding: `${theme.space.xs}px ${theme.space.sm}px`, color: t.textDim2, fontWeight: 700, fontSize: "0.85em", letterSpacing: "0.06em", textTransform: "uppercase", fontFamily: theme.font.label }}>Setting</th>
                {snapshots.map((s, i) => (
                  <th key={i} style={{ textAlign: "right", padding: `${theme.space.xs}px ${theme.space.sm}px`, fontWeight: 700, fontSize: "0.85em" }}>
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: theme.space.xs }}>
                      <span style={{ color: i === 0 ? t.textDim : t.accent, letterSpacing: "0.04em", textTransform: "uppercase", fontFamily: theme.font.label, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                      <button onClick={() => removeSnap(i)} aria-label={`Remove ${s.label}`} style={{ border: "none", background: "transparent", color: t.textDim2, cursor: "pointer", fontSize: "0.85em", padding: 0, lineHeight: 1, flexShrink: 0 }}>✕</button>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const values = snapshots.map((s) => row.get(s));
                return (
                  <tr key={row.label} style={{ borderBottom: `1px solid ${t.gridLine}` }}>
                    <td style={{ padding: `${theme.space.xs}px ${theme.space.sm}px`, fontWeight: 500, color: t.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</td>
                    {values.map((v, i) => {
                      // First column is the reference; later columns highlight (amber =
                      // neutral "differs", not gain/loss) when they diverge from it.
                      const changed = i > 0 && v != null && values[0] != null && v !== values[0];
                      return (
                        <td key={i} style={{ padding: `${theme.space.xs}px ${theme.space.sm}px`, textAlign: "right", fontFamily: mono, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: changed ? t.amber : t.text }}>
                          {row.fmt(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export const setupComparisonDef: WidgetDefinition<SetupComparisonConfig> = {
  id: "setup-comparison",
  name: "Setup Comparison",
  // Work in progress — hidden from the catalog in release builds (see contract).
  draft: true,
  defaultSize: { w: 380, h: 300 },
  minSize: { w: 280, h: 180 },
  defaultConfig,
  requiredPaths: ["slow"],
  requiredCapabilities: ["carSetup"],
  configSchema: [
    { key: "label", label: "Snapshot label", type: "enum", options: [{ value: "Snapshot A", label: "Snapshot A" }, { value: "Snapshot B", label: "Snapshot B" }, { value: "Baseline", label: "Baseline" }] },
  ],
  Component: SetupComparison,
};
