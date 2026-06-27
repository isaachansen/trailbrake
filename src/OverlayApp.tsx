// The transparent overlay surface: renders the active profile's widgets, and in
// edit mode the on-screen drag/resize affordances + toolbar + perf HUD. Shown
// and hidden natively by the backend (session-driven or via the manager); this
// component only paints whatever the layout store holds.

import { useEffect, useState, useSyncExternalStore } from "react";
import { defaultTheme } from "./theme/theme";
import { initTransport, isTauri } from "./store/transport";
import { editModeStore } from "./store/editMode";
import { controls, type VrWidgetLayout } from "./store/controls";
import { useCaps, useSlow } from "./store/hooks";
import { useVrStatus, useStatus } from "./store/session";
import { store } from "./store/store";
import { startBrowserMock } from "./store/mockSource";
import { deriveSessionState } from "./store/sessionState";
import { layoutStore, useLayout } from "./store/layout";
import { getWidgetDef } from "./widgets/registry";
import { ScreenLayerContext } from "./components/screenLayer";
import { WidgetHost } from "./components/WidgetHost";
import { Toolbar } from "./components/Toolbar";
import { SettingsPanel } from "./components/SettingsPanel";
import { PerfHud } from "./perf/PerfHud";

export default function OverlayApp() {
  const theme = defaultTheme;
  const editing = useSyncExternalStore(editModeStore.subscribe, editModeStore.get);
  const layout = useLayout();
  const caps = useCaps();
  const slow = useSlow();
  const carName = slow?.carName ?? null;
  const sessionState = deriveSessionState(slow);
  const vr = useVrStatus();
  const status = useStatus();

  // Demo data while idle: when the overlay is on screen (preview or edit) but no
  // sim is feeding it, run the mock so widgets show realistic data instead of
  // empty panels — you can preview and lay out the overlay without a session.
  // Real telemetry always wins: the moment a session starts (sessionActive), the
  // mock stops and the backend's live data takes over. Tauri-only — the browser
  // dev shell already runs the mock continuously (see store/transport.ts).
  const idlePreview = isTauri() && status.overlayVisible && !status.sessionActive;
  useEffect(() => {
    if (!idlePreview) return;
    return startBrowserMock(store);
  }, [idlePreview]);

  // Viewport-level layer that screen-effect widgets (Spotter edge glow) portal
  // into — they can't reach the viewport from inside their backdrop-filtered box.
  const [screenLayer, setScreenLayer] = useState<HTMLDivElement | null>(null);

  // Per-car profile auto-switch: when the car model changes, switch to its bound
  // profile (if any).
  useEffect(() => {
    layoutStore.handleCar(carName);
  }, [carName]);

  // Drop any widget selection when leaving edit mode, so no stale selection ring /
  // settings panel lingers in race mode.
  useEffect(() => {
    if (!editing) layoutStore.select(null);
  }, [editing]);

  // Start the data transport and load the saved layout once.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    initTransport().then((c) => {
      if (cancelled) c();
      else cleanup = c;
    });
    void layoutStore.init();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  // When the VR compositor is running, mirror the *visible* widgets (same rules
  // WidgetHost applies) to the backend as panel rectangles. The overlay window is
  // the authority for what's actually on screen, and a widget's 2-D spot drives
  // its 3-D placement. Rects are converted to physical pixels (× DPR) to match
  // what Windows Graphics Capture reads.
  useEffect(() => {
    if (!vr.active) return;
    const current = layout.profiles[layout.active];
    if (!current) return;
    const dpr = window.devicePixelRatio || 1;
    const payload: VrWidgetLayout[] = [];
    for (const inst of current.widgets) {
      const def = getWidgetDef(inst.type);
      if (!def || !inst.visible) continue;
      const missing = def.requiredCapabilities.some((c) => caps && !caps[c]);
      if (missing) continue;
      const eff = layoutStore.getEffective(inst);
      if (sessionState != null && !eff.showIn.includes(sessionState)) continue;
      payload.push({
        id: inst.instanceId,
        x: Math.round(inst.position.x * dpr),
        y: Math.round(inst.position.y * dpr),
        w: Math.round(inst.size.w * dpr),
        h: Math.round(inst.size.h * dpr),
        depthM: inst.vrDepth ?? 0,
      });
    }
    void controls.vrSetLayout(payload);
  }, [vr.active, layout, caps, sessionState]);

  // In a plain browser, `e` toggles edit mode (the Tauri app uses a global shortcut).
  useEffect(() => {
    if (isTauri()) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "e" && !e.repeat) void controls.toggleEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = layout.profiles[layout.active];
  const selected = current?.widgets.find((w) => w.instanceId === layout.selectedId) ?? null;

  return (
    <div
      className="overlay-root"
      // The surface itself never captures clicks — only the widgets (in edit mode)
      // and the on-overlay controls do, via their own pointer-events. This keeps
      // empty areas click-through (to the game, or to the manager UI in the dev
      // shell) even while editing.
      style={{ pointerEvents: "none" }}
      onPointerDown={(e) => {
        // Click on empty overlay clears selection.
        if (editing && e.target === e.currentTarget) layoutStore.select(null);
      }}
    >
      {/* Screen-effect layer (under the widgets): the Spotter edge glow portals
          its full-height red side fades here when a car is alongside. */}
      <div ref={setScreenLayer} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />

      <ScreenLayerContext.Provider value={{ el: screenLayer, preview: false, fullScreen: true }}>
        {current?.widgets.map((inst) => (
          <WidgetHost
            key={inst.instanceId}
            instance={inst}
            editing={editing}
            selected={inst.instanceId === layout.selectedId}
            theme={theme}
            caps={caps}
            sessionState={sessionState}
          />
        ))}
      </ScreenLayerContext.Provider>

      {editing && (
        <Toolbar
          theme={theme}
          active={layout.active}
          profiles={layoutStore.listProfiles()}
          carName={carName}
          boundProfile={carName ? layout.carProfiles[carName] ?? null : null}
        />
      )}
      {editing && <PerfHud theme={theme} />}
      {editing && selected && <SettingsPanel instance={selected} theme={theme} />}

      {editing && (
        <div style={{ position: "absolute", bottom: 8, left: 8, display: "flex", alignItems: "center", gap: 10, pointerEvents: "none" }}>
          {/* Clickable way out of edit mode, for when you don't want the hotkey. */}
          <button
            onClick={() => void controls.setEdit(false)}
            title="Stop editing (also: edit-mode hotkey)"
            style={{
              pointerEvents: "auto",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              background: theme.colors.accent,
              color: "#0a0b0e",
              border: "none",
              borderRadius: theme.radius,
              font: `700 12px ${theme.font.family}`,
              letterSpacing: "0.04em",
              boxShadow: theme.panelShadow,
            }}
          >
            ✓ Done editing
          </button>
          <span
            style={{
              padding: "4px 10px",
              background: "rgba(0,0,0,0.55)",
              border: `1px solid ${theme.colors.surfaceBorder}`,
              borderRadius: theme.radius,
              font: `600 11px ${theme.font.family}`,
              color: theme.colors.textDim,
            }}
          >
            Drag / resize widgets · {isTauri() ? "hotkey" : "“e”"} also exits
          </span>
        </div>
      )}
    </div>
  );
}
