// Per-widget configuration: the common appearance props (opacity / scale / when
// it shows) — each able to inherit the global default ("Use general") or be
// overridden per widget — plus the widget's own schema-driven options. Mutates
// the shared layout store, which syncs live to the on-screen overlay.

import type { ReactNode } from "react";
import { layoutStore, type WidgetInstance } from "../store/layout";
import { getWidgetDef } from "../widgets/registry";
import { SESSION_STATES, type SessionStateKey } from "../store/sessionState";
import type { InfoFieldConfig } from "../widgets/contract";
import { Field, Slider, Toggle } from "./ui";
import { FieldListEditor } from "./FieldListEditor";
import { ColorField } from "./ColorField";

interface Props {
  instance: WidgetInstance;
}

function GeneralRow({
  label,
  useGeneral,
  onUseGeneral,
  summary,
  children,
}: {
  label: string;
  useGeneral: boolean;
  onUseGeneral: (v: boolean) => void;
  summary: string;
  children: ReactNode;
}) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, width: "100%" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12.5, color: "var(--dim)" }}>
          <Toggle on={useGeneral} onChange={onUseGeneral} /> Use global default
        </label>
        {useGeneral ? (
          <span className="muted" style={{ fontSize: 12.5 }}>{summary}</span>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", flexWrap: "wrap" }}>{children}</div>
        )}
      </div>
    </Field>
  );
}

function summarizeStates(states: SessionStateKey[]): string {
  if (states.length >= SESSION_STATES.length) return "Always";
  if (states.length === 0) return "Never";
  return SESSION_STATES.filter((s) => states.includes(s.key)).map((s) => s.label).join(", ");
}

export function WidgetConfigEditor({ instance }: Props) {
  const def = getWidgetDef(instance.type);
  if (!def) return null;

  const defaults = layoutStore.getDefaults();
  const setInstance = (partial: Partial<WidgetInstance>) => layoutStore.updateInstance(instance.instanceId, partial);

  // Apply a config change and, for widgets whose height is content-driven, resize
  // the instance by the toggled section's contribution — so removing a section
  // makes the widget shorter rather than letting the rest stretch. The delta
  // (not an absolute set) preserves any manual resizing the user has done.
  const setConfig = (partial: Record<string, unknown>) => {
    if (def.contentHeight) {
      const next = { ...instance.config, ...partial };
      const deltaDesign = def.contentHeight(next) - def.contentHeight(instance.config);
      if (deltaDesign !== 0) {
        const eff = layoutStore.getEffective(instance);
        const minH = layoutStore.minSizeFor(instance).h;
        const h = Math.max(minH, Math.round(instance.size.h + deltaDesign * eff.scale));
        setInstance({ size: { w: instance.size.w, h } });
      }
    }
    layoutStore.updateConfig(instance.instanceId, partial);
  };

  const toggleState = (key: SessionStateKey) => {
    const cur = instance.showIn;
    setInstance({ showIn: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  };

  return (
    <div>
      <GeneralRow
        label="Opacity"
        useGeneral={instance.useGeneralOpacity}
        onUseGeneral={(v) => setInstance(v ? { useGeneralOpacity: true } : { useGeneralOpacity: false, opacity: defaults.opacity })}
        summary={`Global · ${Math.round(defaults.opacity * 100)}%`}
      >
        <Slider value={instance.opacity} min={0.2} max={1} step={0.02} onChange={(v) => setInstance({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
      </GeneralRow>

      <GeneralRow
        label="Scale"
        useGeneral={instance.useGeneralScale}
        onUseGeneral={(v) => setInstance(v ? { useGeneralScale: true } : { useGeneralScale: false, scale: defaults.scale })}
        summary={`Global · ${defaults.scale.toFixed(2)}×`}
      >
        <Slider value={instance.scale} min={0.6} max={2} step={0.05} onChange={(v) => setInstance({ scale: v })} format={(v) => `${v.toFixed(2)}×`} />
      </GeneralRow>

      <GeneralRow
        label="Show overlay when"
        useGeneral={instance.useGeneralShowIn}
        onUseGeneral={(v) => setInstance(v ? { useGeneralShowIn: true } : { useGeneralShowIn: false, showIn: [...defaults.showIn] })}
        summary={`Global · ${summarizeStates(defaults.showIn)}`}
      >
        <div className="state-toggles">
          {SESSION_STATES.map((s) => (
            <button key={s.key} className={`state-chip${instance.showIn.includes(s.key) ? " on" : ""}`} onClick={() => toggleState(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </GeneralRow>

      {def.configSchema.map((f) => {
        const value = instance.config[f.key];
        if (f.type === "boolean") {
          return (
            <Field label={f.label} key={f.key}>
              <Toggle on={Boolean(value)} onChange={(v) => setConfig({ [f.key]: v })} />
            </Field>
          );
        }
        if (f.type === "number") {
          return (
            <Field label={f.label} key={f.key}>
              <Slider value={Number(value)} min={f.min} max={f.max} step={f.step} onChange={(v) => setConfig({ [f.key]: v })} />
            </Field>
          );
        }
        if (f.type === "fieldList") {
          return (
            <FieldListEditor
              key={f.key}
              label={f.label}
              catalog={f.fields}
              value={value as InfoFieldConfig[] | undefined}
              onChange={(next) => setConfig({ [f.key]: next })}
            />
          );
        }
        if (f.type === "color") {
          return (
            <Field label={f.label} key={f.key}>
              <ColorField value={String(value ?? f.presets[0]?.hex ?? "#ffffff")} presets={f.presets} onChange={(hex) => setConfig({ [f.key]: hex })} />
            </Field>
          );
        }
        return (
          <Field label={f.label} key={f.key}>
            <select className="select" style={{ flex: 1 }} value={String(value)} onChange={(e) => setConfig({ [f.key]: e.target.value })}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>
        );
      })}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => layoutStore.resetConfig(instance.instanceId)}>
          Reset options
        </button>
      </div>
    </div>
  );
}
