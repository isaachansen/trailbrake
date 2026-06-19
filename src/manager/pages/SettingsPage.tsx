// App settings: session auto-show, which monitor the overlay lives on, the
// active telemetry source, and a manual overlay show/hide.

import { useEffect, useState } from "react";
import { settingsStore, useSettings } from "../../store/appSettings";
import { useStatus } from "../../store/session";
import { controls, type MonitorInfo } from "../../store/controls";
import { isTauri } from "../../store/transport";
import { layoutStore, useLayout } from "../../store/layout";
import { SESSION_STATES } from "../../store/sessionState";
import { Field, Slider, Toggle } from "../ui";

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
  const layout = useLayout();
  const defaults = layout.defaults;
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);

  useEffect(() => {
    void controls.listMonitors().then(setMonitors);
  }, []);

  return (
    <div>
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
        <Field label="Spotter edge glow">
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span className="hint">Glow the full left/right edge of the screen red when a car is alongside (iRacing spotter).</span>
            <Toggle on={layout.spotterEdges} onChange={(v) => layoutStore.setSpotterEdges(v)} />
          </div>
        </Field>
      </div>

      <div className="card">
        <div className="card-title">Overlay defaults</div>
        <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
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
