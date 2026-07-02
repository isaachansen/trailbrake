// Per-widget settings, shown in edit mode for the selected widget. Common props
// (opacity/scale/visibility/lock) plus the widget's own options, rendered
// generically from its `configSchema` — so a new widget gets a settings UI for
// free just by declaring its schema.

import { layoutStore, type WidgetInstance } from "../store/layout";
import { getWidgetDef } from "../widgets/registry";
import { SESSION_STATES } from "../store/sessionState";
import { SESSION_TYPES, reconcileFieldList, type ConfigField, type InfoFieldConfig, type SessionType } from "../widgets/contract";
import type { Theme } from "../theme/theme";

interface Props {
  instance: WidgetInstance;
  theme: Theme;
}

export function SettingsPanel({ instance, theme }: Props) {
  const def = getWidgetDef(instance.type);
  if (!def) return null;

  // Fresh widgets inherit the global opacity/scale/showIn ("Use general" — see
  // layout.ts:makeInstance). Show the value that's *actually applied*
  // (WidgetHost renders `getEffective`, too) rather than the instance's raw
  // (often stale/irrelevant) own field, which used to make the panel lie about
  // the current appearance and jump the moment you touched a slider.
  const eff = layoutStore.getEffective(instance);

  const labelStyle: React.CSSProperties = { color: theme.colors.textDim, fontSize: 11, flex: "0 0 96px" };
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, minHeight: 24 };

  const num = (key: string, value: number, f: Extract<ConfigField, { type: "number" }>) => (
    <div style={rowStyle} key={key}>
      <span style={labelStyle}>{f.label}</span>
      <input
        type="range"
        min={f.min}
        max={f.max}
        step={f.step}
        value={value}
        onChange={(e) => layoutStore.updateConfig(instance.instanceId, { [key]: Number(e.target.value) })}
        style={{ flex: 1 }}
      />
      <span style={{ width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );

  // Compact info-field list: on/off + per-session-type, with ▲▼ reorder (the
  // full drag editor lives in the manager). Stored value is `InfoFieldConfig[]`.
  const fieldList = (f: Extract<ConfigField, { type: "fieldList" }>) => {
    const rows = reconcileFieldList(instance.config[f.key] as InfoFieldConfig[] | undefined, f.fields);
    const labels = new Map(f.fields.map((c) => [c.key, c.label]));
    const commit = (next: InfoFieldConfig[]) => layoutStore.updateConfig(instance.instanceId, { [f.key]: next });
    const move = (i: number, dir: -1 | 1) => {
      const j = i + dir;
      if (j < 0 || j >= rows.length) return;
      const next = [...rows];
      [next[i], next[j]] = [next[j], next[i]];
      commit(next);
    };
    const toggleSession = (i: number, s: SessionType) =>
      commit(
        rows.map((r, k) =>
          k === i
            ? { ...r, sessions: r.sessions.includes(s) ? r.sessions.filter((x) => x !== s) : [...r.sessions, s] }
            : r
        )
      );
    const setOn = (i: number, on: boolean) => commit(rows.map((r, k) => (k === i ? { ...r, on } : r)));
    const sbtn = (active: boolean): React.CSSProperties => ({
      cursor: "pointer",
      fontSize: 9.5,
      fontWeight: 600,
      padding: "1px 5px",
      borderRadius: 999,
      border: `1px solid ${active ? theme.colors.accent : theme.colors.surfaceBorder}`,
      background: active ? "rgba(255,45,142,0.18)" : "transparent",
      color: active ? theme.colors.text : theme.colors.textDim,
    });
    return (
      <div key={f.key} style={{ marginTop: 6 }}>
        <span style={{ ...labelStyle, flex: "none", display: "block", marginBottom: 4 }}>{f.label}</span>
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 22 }}>
            <span style={{ display: "flex", flexDirection: "column", lineHeight: 0.8 }}>
              <button onClick={() => move(i, -1)} disabled={i === 0} style={reorderBtn(theme, i === 0)} title="Move up">▲</button>
              <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} style={reorderBtn(theme, i === rows.length - 1)} title="Move down">▼</button>
            </span>
            <input type="checkbox" checked={r.on} onChange={(e) => setOn(i, e.target.checked)} />
            <span style={{ flex: 1, fontSize: 11, color: r.on ? theme.colors.text : theme.colors.textDim, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.get(r.key)}</span>
            <span style={{ display: "flex", gap: 3 }}>
              {SESSION_TYPES.map((s) => (
                <button key={s.key} onClick={() => toggleSession(i, s.key)} style={sbtn(r.sessions.includes(s.key))} title={`Show in ${s.label}`}>
                  {s.label[0].toUpperCase()}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
    );
  };

  const textField = (f: Extract<ConfigField, { type: "text" }>) => (
    <div style={rowStyle} key={f.key}>
      <span style={labelStyle}>{f.label}</span>
      <input
        type="text"
        value={String(instance.config[f.key] ?? "")}
        placeholder={f.placeholder}
        onChange={(e) => layoutStore.updateConfig(instance.instanceId, { [f.key]: e.target.value })}
        style={{
          flex: 1,
          background: "rgba(255,255,255,0.06)",
          color: theme.colors.text,
          border: `1px solid ${theme.colors.surfaceBorder}`,
          borderRadius: 4,
          padding: "2px 6px",
          font: `500 12px ${theme.font.family}`,
        }}
      />
    </div>
  );

  // Compact color control: preset swatches + the native picker for a custom hex.
  // (The manager's customize modal has the full color wheel; this on-overlay
  // panel stays lightweight and doesn't depend on the manager stylesheet.)
  const colorField = (f: Extract<ConfigField, { type: "color" }>) => {
    const value = String(instance.config[f.key] ?? f.presets[0]?.hex ?? "#ffffff");
    const set = (hex: string) => layoutStore.updateConfig(instance.instanceId, { [f.key]: hex });
    return (
      <div style={rowStyle} key={f.key}>
        <span style={labelStyle}>{f.label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, flexWrap: "wrap" }}>
          {f.presets.map((p) => (
            <button
              key={p.hex}
              title={p.name}
              onClick={() => set(p.hex)}
              style={{
                width: 16,
                height: 16,
                padding: 0,
                borderRadius: "50%",
                background: p.hex,
                cursor: "pointer",
                border: value.toLowerCase() === p.hex.toLowerCase() ? "2px solid #fff" : "2px solid transparent",
                boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.4)",
              }}
            />
          ))}
          <input
            type="color"
            title="Custom color"
            value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff"}
            onChange={(e) => set(e.target.value)}
            style={{ width: 20, height: 18, padding: 0, border: "none", background: "transparent", cursor: "pointer" }}
          />
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 44,
        right: 8,
        width: 232,
        padding: 10,
        background: "rgba(10,12,16,0.92)",
        border: `1px solid ${theme.colors.surfaceBorder}`,
        borderRadius: theme.radius,
        color: theme.colors.text,
        font: `500 12px ${theme.font.family}`,
        pointerEvents: "auto",
        maxHeight: "calc(100vh - 60px)",
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ color: theme.colors.edit }}>{def.name}</strong>
        <button onClick={() => layoutStore.removeWidget(instance.instanceId)} style={btn(theme.colors.loss)}>
          Remove
        </button>
      </div>

      {/* Common props */}
      <div style={rowStyle}>
        <span style={labelStyle}>Opacity</span>
        <input type="range" min={0.2} max={1} step={0.02} value={eff.opacity}
          // First touch materializes: starts from the effective (possibly
          // inherited) value and only then overrides it, so nothing jumps.
          onChange={(e) => layoutStore.updateInstance(instance.instanceId, { opacity: Number(e.target.value), useGeneralOpacity: false })} style={{ flex: 1 }} />
        <span style={{ width: 34, textAlign: "right" }}>{eff.opacity.toFixed(2)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Scale</span>
        <input type="range" min={0.6} max={2} step={0.05} value={eff.scale}
          onChange={(e) => layoutStore.updateInstance(instance.instanceId, { scale: Number(e.target.value), useGeneralScale: false })} style={{ flex: 1 }} />
        <span style={{ width: 34, textAlign: "right" }}>{eff.scale.toFixed(2)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Visible</span>
        <input type="checkbox" checked={instance.visible}
          onChange={(e) => layoutStore.updateInstance(instance.instanceId, { visible: e.target.checked })} />
        <span style={{ ...labelStyle, flex: "0 0 60px", marginLeft: 12 }}>Locked</span>
        <input type="checkbox" checked={instance.locked}
          onChange={(e) => layoutStore.updateInstance(instance.instanceId, { locked: e.target.checked })} />
      </div>
      <div style={{ ...rowStyle, alignItems: "flex-start" }}>
        <span style={{ ...labelStyle, marginTop: 3 }}>Show when</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, flex: 1 }}>
          {SESSION_STATES.map((s) => {
            const on = eff.showIn.includes(s.key);
            return (
              <button
                key={s.key}
                onClick={() =>
                  // Materialize from the effective set (own if already
                  // overridden, else the inherited global) so toggling one
                  // state doesn't silently reset the others to the default.
                  layoutStore.updateInstance(instance.instanceId, {
                    useGeneralShowIn: false,
                    showIn: on ? eff.showIn.filter((k) => k !== s.key) : [...eff.showIn, s.key],
                  })
                }
                style={{
                  cursor: "pointer",
                  fontSize: 10.5,
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: `1px solid ${on ? theme.colors.accent : theme.colors.surfaceBorder}`,
                  background: on ? "rgba(255,45,142,0.18)" : "transparent",
                  color: on ? theme.colors.text : theme.colors.textDim,
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle} title="In VR: push this panel nearer (−) or farther (+) than the others">VR depth</span>
        <input type="range" min={-0.6} max={0.6} step={0.05} value={instance.vrDepth ?? 0}
          onChange={(e) => layoutStore.updateInstance(instance.instanceId, { vrDepth: Number(e.target.value) })} style={{ flex: 1 }} />
        <span style={{ width: 34, textAlign: "right" }}>{(instance.vrDepth ?? 0).toFixed(2)}</span>
      </div>

      <div style={{ borderTop: `1px solid ${theme.colors.surfaceBorder}`, margin: "8px 0" }} />

      {/* Widget-specific schema */}
      {def.configSchema.map((f) => {
        const value = instance.config[f.key];
        if (f.type === "boolean") {
          return (
            <div style={rowStyle} key={f.key}>
              <span style={labelStyle}>{f.label}</span>
              <input type="checkbox" checked={Boolean(value)}
                onChange={(e) => layoutStore.updateConfig(instance.instanceId, { [f.key]: e.target.checked })} />
            </div>
          );
        }
        if (f.type === "number") return num(f.key, Number(value), f);
        if (f.type === "fieldList") return fieldList(f);
        if (f.type === "color") return colorField(f);
        if (f.type === "text") return textField(f);
        // enum
        return (
          <div style={rowStyle} key={f.key}>
            <span style={labelStyle}>{f.label}</span>
            <select value={String(value)} onChange={(e) => layoutStore.updateConfig(instance.instanceId, { [f.key]: e.target.value })}
              style={{ flex: 1, background: "rgba(255,255,255,0.06)", color: theme.colors.text, border: `1px solid ${theme.colors.surfaceBorder}`, borderRadius: 4, padding: "2px 4px" }}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        );
      })}

      <div style={{ marginTop: 8 }}>
        <button onClick={() => layoutStore.resetConfig(instance.instanceId)} style={btn(theme.colors.textDim)}>
          Reset options
        </button>
      </div>
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${color}`,
    color,
    borderRadius: 4,
    padding: "2px 8px",
    fontSize: 11,
    cursor: "pointer",
  };
}

function reorderBtn(theme: Theme, disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: disabled ? theme.colors.surfaceBorder : theme.colors.textDim,
    cursor: disabled ? "default" : "pointer",
    fontSize: 7,
    lineHeight: 1,
    padding: 0,
    height: 9,
  };
}
