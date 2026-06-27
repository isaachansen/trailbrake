// App settings: session auto-show, which monitor the overlay lives on, the
// active telemetry source, and a manual overlay show/hide.

import { useEffect, useState } from "react";
import { settingsStore, useSettings } from "../../store/appSettings";
import { useStatus, useVrStatus } from "../../store/session";
import { controls, type MonitorInfo, type VrBackendKind } from "../../store/controls";
import { isTauri } from "../../store/transport";
import { layoutStore, useLayout } from "../../store/layout";
import { SESSION_STATES } from "../../store/sessionState";
import { Field, Slider, Toggle } from "../ui";

const VR_BACKENDS: { value: VrBackendKind; label: string }[] = [
  { value: "auto", label: "Auto (OpenVR, then OpenXR)" },
  { value: "openvr", label: "OpenVR (SteamVR)" },
  { value: "openxr", label: "OpenXR (best-effort)" },
];

const SOURCE_LABEL: Record<string, string> = {
  iracing: "iRacing (live)",
  mock: "Mock (synthetic)",
  replay: "Replay (recorded)",
  auto: "Auto-detect",
  "": "Auto-detect",
};

export function SettingsPage() {
  const settings = useSettings();
  const status = useStatus();
  const vr = useVrStatus();
  const layout = useLayout();
  const defaults = layout.defaults;
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);

  useEffect(() => {
    void controls.listMonitors().then(setMonitors);
    void controls.vrStatus();
  }, []);

  const vrCfg = settings.vr;
  // Status line: prefer the live backend message; fall back to a sensible hint.
  const vrLine = vr.active
    ? `${vr.backend} active`
    : vr.message || (vr.available ? "Ready" : "Start SteamVR, then enable");

  return (
    <div className="settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>How and where the overlay appears.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Overlay behaviour</div>
        <Field label="Auto-show in session">
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span className="hint">Show the overlay automatically when a session starts, hide it when it ends.</span>
            <Toggle on={settings.autoShow} onChange={(v) => void settingsStore.setAutoShow(v)} />
          </div>
        </Field>
        <Field label="Show on desktop">
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span className="hint">Keep the overlay visible now, even outside a session (for arranging widgets).</span>
            <Toggle on={status.preview || status.editing} onChange={(v) => void controls.setPreview(v)} />
          </div>
        </Field>
      </div>

      <div className="card">
        <div className="card-title">Overlay defaults</div>
        <p className="card-desc">
          Applied to every widget set to “Use global default”. Any widget can override these from its own card.
        </p>
        <Field label="Opacity">
          <Slider value={defaults.opacity} min={0.2} max={1} step={0.02} onChange={(v) => layoutStore.setDefault({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
        <Field label="Scale">
          <Slider value={defaults.scale} min={0.6} max={2} step={0.05} onChange={(v) => layoutStore.setDefault({ scale: v })} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
        <Field label="Show overlay when">
          <div className="state-toggles">
            {SESSION_STATES.map((s) => {
              const on = defaults.showIn.includes(s.key);
              return (
                <button
                  key={s.key}
                  className={`state-chip${on ? " on" : ""}`}
                  onClick={() => layoutStore.setDefault({ showIn: on ? defaults.showIn.filter((k) => k !== s.key) : [...defaults.showIn, s.key] })}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </Field>
      </div>

      <div className="card">
        <div className="card-title">Display</div>
        <Field label="Units">
          <div className="state-toggles">
            {([["metric", "Metric (km/h, L, °C)"], ["imperial", "Imperial (mph, gal, °F)"]] as const).map(([key, label]) => (
              <button
                key={key}
                className={`state-chip${settings.units === key ? " on" : ""}`}
                onClick={() => settingsStore.setUnits(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Overlay monitor">
          {monitors.length > 1 ? (
            <select
              className="select"
              style={{ flex: 1 }}
              value={settings.monitorIndex ?? ""}
              onChange={(e) => void settingsStore.setMonitorIndex(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">Auto (secondary monitor)</option>
              {monitors.map((m) => (
                <option key={m.index} value={m.index}>
                  Display {m.index + 1} — {m.width}×{m.height}
                  {m.isPrimary ? " (primary)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="hint">
              {isTauri() ? "Only one display detected — the overlay uses it." : "Monitor selection is available in the desktop app."}
            </span>
          )}
        </Field>
        <Field label="Telemetry source">
          <span className="hint" style={{ flex: 1 }}>
            {SOURCE_LABEL[status.source] ?? status.source}
            <span className="muted"> · set with the OVERLAY_SOURCE environment variable</span>
          </span>
        </Field>
      </div>

      <div className="card">
        <div className="card-title">Virtual reality</div>
        <p className="card-desc">
          Show each widget as its own floating panel in the headset, placed where it sits on the flat overlay.
          Needs the app built with VR support and your sim running through SteamVR.
        </p>
        <Field label="Enable VR overlays">
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span className="hint">
              {vrLine}
              {vr.backend && vr.backend !== "none" ? <span className="muted"> · {vr.backend}</span> : null}
            </span>
            <Toggle on={vrCfg.enabled} onChange={(v) => void settingsStore.setVrEnabled(v)} />
          </div>
        </Field>
        <Field label="Runtime">
          <select
            className="select"
            style={{ flex: 1 }}
            value={vrCfg.backend}
            onChange={(e) => settingsStore.setVrBackend(e.target.value as VrBackendKind)}
          >
            {VR_BACKENDS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Distance">
          <Slider value={vrCfg.distanceM} min={0.4} max={3} step={0.05}
            onChange={(v) => settingsStore.setVrGlobals({ distanceM: v })} format={(v) => `${v.toFixed(2)} m`} />
        </Field>
        <Field label="Panel size">
          <Slider value={vrCfg.scale} min={0.4} max={2.5} step={0.05}
            onChange={(v) => settingsStore.setVrGlobals({ scale: v })} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
        <Field label="Curvature">
          <Slider value={vrCfg.curvature} min={0} max={1} step={0.05}
            onChange={(v) => settingsStore.setVrGlobals({ curvature: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
        <Field label="Follow head">
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span className="hint">Panels follow your view instead of staying fixed in the cockpit.</span>
            <Toggle on={vrCfg.headLocked} onChange={(v) => settingsStore.setVrGlobals({ headLocked: v })} />
          </div>
        </Field>
        <Field label="Recenter">
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span className="hint">Re-anchor panels to your current seated view (or use SteamVR's recenter).</span>
            <button className="state-chip" onClick={() => void controls.vrRecenter()} disabled={!vr.active}>
              Recenter
            </button>
          </div>
        </Field>
        <p className="hint" style={{ marginTop: 6 }}>
          Per-widget depth (nearer/farther) is on each widget's settings card in edit mode. Tip: OpenXR overlay
          compositing isn't supported by current runtimes, so VR runs on OpenVR/SteamVR.
        </p>
      </div>

      <div className="card">
        <div className="card-title">About</div>
        <div className="hint">
          <b style={{ color: "var(--text)" }}>Trailbrake</b> — a customizable telemetry overlay for racing sims.
          Closing this window keeps it running in the system tray; reopen it from the tray icon. The overlay shows
          automatically when you're in a session and hides when it's over.
        </div>
      </div>
    </div>
  );
}
