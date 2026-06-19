// The transparent overlay surface: renders the active profile's widgets, and in
// edit mode the on-screen drag/resize affordances + toolbar + perf HUD. Shown
// and hidden natively by the backend (session-driven or via the manager); this
// component only paints whatever the layout store holds.

import { useEffect, useSyncExternalStore } from "react";
import { defaultTheme } from "./theme/theme";
import { initTransport, isTauri } from "./store/transport";
import { editModeStore } from "./store/editMode";
import { controls } from "./store/controls";
import { useCaps, useSlow } from "./store/hooks";
import { deriveSessionState } from "./store/sessionState";
import { layoutStore, useLayout } from "./store/layout";
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
  const carLeft = slow?.carLeft ?? false;
  const carRight = slow?.carRight ?? false;

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
      {/* Spotter: full-height red glow on the side a car is alongside. */}
      {layout.spotterEdges && (
        <>
          <div
            className="spotter-edge"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: "8%",
              pointerEvents: "none",
              background: "linear-gradient(to right, rgba(255,40,55,0.32), rgba(255,40,55,0))",
              opacity: carLeft ? 0.9 : 0,
              transition: "opacity 0.16s ease",
            }}
          />
          <div
            className="spotter-edge"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: 0,
              width: "8%",
              pointerEvents: "none",
              background: "linear-gradient(to left, rgba(255,40,55,0.32), rgba(255,40,55,0))",
              opacity: carRight ? 0.9 : 0,
              transition: "opacity 0.16s ease",
            }}
          />
        </>
      )}

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
