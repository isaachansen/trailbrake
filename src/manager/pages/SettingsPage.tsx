// App settings: session auto-show, which monitor the overlay lives on, the
// active telemetry source, and a manual overlay show/hide.

import { useEffect, useState } from "react";
import { settingsStore, useSettings, DEFAULT_SETTINGS } from "../../store/appSettings";
import { useStatus, useVrStatus } from "../../store/session";
import { controls, type MonitorInfo, type VrBackendKind } from "../../store/controls";
import { isTauri } from "../../store/transport";
import { layoutStore, useLayout } from "../../store/layout";
import { SESSION_STATES } from "../../store/sessionState";
import { Field, Slider, Toggle } from "../ui";
import { ACCENT_PRESETS } from "../accent";
import { ColorWheel } from "../ColorWheel";
import { SoftwareUpdates } from "./SoftwareUpdates";
import { BuyMeACoffee } from "../BuyMeACoffee";

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

/** Map a KeyboardEvent to an accelerator key token, or null if not a usable key. */
function keyToken(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === "Space") return "Space";
  return null;
}

export function SettingsPage() {
  const settings = useSettings();
  const status = useStatus();
  const vr = useVrStatus();
  const layout = useLayout();
  const defaults = layout.defaults;
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [hotkeyWarn, setHotkeyWarn] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [vrError, setVrError] = useState<string | null>(null);

  useEffect(() => {
    void controls.listMonitors().then(setMonitors);
    void controls.vrStatus();
  }, []);

  // Apply a new accelerator and surface a registration failure (e.g. the chord
  // is already bound elsewhere) inline instead of swallowing it.
  const applyHotkey = (accel: string) => {
    setHotkeyError(null);
    void settingsStore.setEditHotkey(accel).then((result) => {
      setHotkeyError(typeof result === "string" ? result : null);
    });
  };

  // Capture a real key chord while "capturing", build the accelerator and apply it.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      const tok = keyToken(e);
      if (!tok) return; // wait for a real key, not a bare modifier
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      setCapturing(false);
      setHotkeyWarn(mods.length === 0);
      applyHotkey([...mods, tok].join("+"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  const vrCfg = settings.vr;
  // Status line: prefer the live backend message; fall back to a sensible hint.
  const vrLine = vr.active
    ? `${vr.backend} active`
    : vr.message || (vr.available ? "Ready" : "Start SteamVR, then enable");

  return (
    <div className="settings-page">
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
            <span className="hint">
              {status.editing
                ? "On while edit mode is active — turn off edit mode to control this manually."
                : "Keep the overlay visible now, even outside a session (for arranging widgets)."}
            </span>
            <Toggle
              on={status.preview || status.editing}
              disabled={status.editing}
              title={status.editing ? "Overlay stays visible while edit mode is on" : undefined}
              onChange={(v) => void controls.setPreview(v)}
            />
          </div>
        </Field>
        <Field label="Demo data in preview">
          <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
            <span className="hint">When the overlay is shown without a sim running, fill the widgets with realistic mock data. Live telemetry always takes over once a session starts.</span>
            <Toggle on={settings.previewMock} onChange={(v) => settingsStore.setPreviewMock(v)} />
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
        <Field label="Panel style">
          <div className="state-toggles">
            {([["flat", "Flat glass"], ["liquid", "Liquid Glass"]] as const).map(([key, label]) => (
              <button
                key={key}
                className={`state-chip${settings.panelStyle === key ? " on" : ""}`}
                onClick={() => settingsStore.setPanelStyle(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Accent color">
          <div className="accent-swatches">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.hex}
                type="button"
                title={p.name}
                aria-label={p.name}
                className={`accent-swatch${settings.accentColor.toLowerCase() === p.hex.toLowerCase() ? " on" : ""}`}
                style={{ background: p.hex }}
                onClick={() => settingsStore.setAccentColor(p.hex)}
              />
            ))}
            {(() => {
              const isCustom = !ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === settings.accentColor.toLowerCase());
              return (
                <button
                  type="button"
                  data-accent-trigger
                  title="Custom color"
                  aria-label="Custom color"
                  className={`accent-swatch accent-custom${isCustom ? " on" : ""}${wheelOpen ? " open" : ""}`}
                  style={
                    isCustom
                      ? {
                          // Custom color chosen: solid swatch of that color with a
                          // matching colored rim. (No custom → rainbow pinwheel below.)
                          background: settings.accentColor,
                          borderColor: "transparent",
                          boxShadow: `0 0 0 2px rgba(0, 0, 0, 0.45), 0 0 0 4px ${settings.accentColor}`,
                        }
                      : undefined
                  }
                  onClick={() => setWheelOpen((v) => !v)}
                />
              );
            })()}
            {wheelOpen && (
              <ColorWheel
                value={settings.accentColor}
                onChange={(hex) => settingsStore.setAccentColor(hex)}
                onClose={() => setWheelOpen(false)}
              />
            )}
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
            <span className="muted"> · auto-detects your sim (iRacing); set OVERLAY_SOURCE to force mock/replay in dev</span>
          </span>
        </Field>
      </div>

      <div className="card">
        <div className="card-title">Hotkeys</div>
        <p className="card-desc">Global shortcut to toggle overlay edit mode — works even while the game is focused.</p>
        <div className="hotkey-capture">
          <span className="field-label">Toggle edit mode</span>
          <div className={`hotkey-display${capturing ? " capturing" : ""}`}>
            {capturing ? (
              "Press keys…"
            ) : (
              settings.editHotkey.split("+").map((p, i) => (
                <span key={i} className="kbd">{p}</span>
              ))
            )}
          </div>
          <button className={`btn btn-sm${capturing ? " btn-primary" : ""}`} onClick={() => setCapturing((c) => !c)}>
            {capturing ? "Cancel" : "Change…"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setHotkeyWarn(false);
              applyHotkey(DEFAULT_SETTINGS.editHotkey);
            }}
          >
            Reset
          </button>
        </div>
        {capturing && (
          <div className="hint" style={{ marginTop: 8 }}>
            A letter, number, or function key — usually with Ctrl, Alt, Shift, or ⊞. Esc cancels.
          </div>
        )}
        {hotkeyWarn && (
          <div className="hint" style={{ color: "var(--warn)", marginTop: 8 }}>
            ⚠ No modifier — this may clash with normal typing in games.
          </div>
        )}
        {hotkeyError && <div className="hint error" style={{ marginTop: 8 }}>⚠ {hotkeyError}</div>}
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
            <Toggle
              on={vrCfg.enabled}
              onChange={(v) => {
                setVrError(null);
                void settingsStore.setVrEnabled(v).then((err) => setVrError(err));
              }}
            />
          </div>
        </Field>
        {vrError && <div className="hint error" style={{ marginTop: -4, marginBottom: 4 }}>⚠ {vrError}</div>}
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
            <button className="btn btn-sm" onClick={() => void controls.vrRecenter()} disabled={!vr.active}>
              Recenter
            </button>
          </div>
        </Field>
        <p className="hint" style={{ marginTop: 6 }}>
          Per-widget depth (nearer/farther) is on each widget's settings card in edit mode. Tip: OpenXR overlay
          compositing isn't supported by current runtimes, so VR runs on OpenVR/SteamVR.
        </p>
      </div>

      <SoftwareUpdates />

      <div className="card">
        <div className="card-title">Support Trailbrake</div>
        <p className="card-desc">Trailbrake is free. If it's earned a spot on your sim rig, a coffee keeps it going. ☕</p>
        <div style={{ marginTop: 12 }}>
          <BuyMeACoffee />
        </div>
      </div>

      <div className="card">
        <div className="card-title">About</div>
        <div className="hint">
          <span className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <b style={{ color: "var(--text)" }}>Trailbrake</b>
            <span className="muted" style={{ fontFamily: "var(--mono, monospace)" }}>v{__APP_VERSION__}</span>
          </span>
          A customizable telemetry overlay for racing sims. Closing this window keeps it running in the system tray;
          reopen it from the tray icon. The overlay shows automatically when you're in a session and hides when it's over.
        </div>
      </div>
    </div>
  );
}
