// App-level settings (distinct from widget layout): the edit-mode hotkey,
// session auto-show, and which monitor the overlay lives on. Persisted to its
// own file (`app-settings.json` in Tauri, localStorage in the browser), and on
// load/change the relevant backend command is applied so the running app
// reflects the saved preferences.

import { useSyncExternalStore } from "react";
import { loadSettings, saveSettings } from "./persistence";
import { controls, type VrBackendKind, type VrGlobals } from "./controls";
import type { UnitSystem } from "../widgets/format";

/** Widget panel appearance: the flat-glass default, or the Liquid Glass style. */
export type PanelStyle = "flat" | "liquid";

/** Persisted VR placement settings (mirror of `VrGlobals` + enable/backend). */
export interface VrSettings {
  enabled: boolean;
  backend: VrBackendKind;
  distanceM: number;
  scale: number;
  curvature: number;
  headLocked: boolean;
}

export interface AppSettings {
  /** Accelerator string for the edit-mode toggle, e.g. "Ctrl+Shift+O". */
  editHotkey: string;
  /** Auto-show the overlay when a session starts. */
  autoShow: boolean;
  /** Monitor index for the overlay, or null = auto (secondary monitor). */
  monitorIndex: number | null;
  /** Display units across all widgets (speed/fuel/temp). */
  units: UnitSystem;
  /** Accent color for the manager UI (hex, e.g. "#ff2d8e"). Drives the `--accent`
   *  family of CSS variables; persisted so it survives a reopen. */
  accentColor: string;
  /** Fill widgets with synthetic (mock) telemetry while the overlay is shown
   *  (preview/edit) but no sim is feeding it. Real telemetry always takes over. */
  previewMock: boolean;
  /** Widget panel appearance — flat glass (default) or Liquid Glass. */
  panelStyle: PanelStyle;
  /** VR compositor placement + enable. */
  vr: VrSettings;
}

export const DEFAULT_VR_SETTINGS: VrSettings = {
  enabled: false,
  backend: "auto",
  distanceM: 0.9,
  scale: 1,
  curvature: 0.15,
  headLocked: false,
};

export const DEFAULT_SETTINGS: AppSettings = {
  editHotkey: "Ctrl+Shift+O",
  autoShow: true,
  monitorIndex: null,
  units: "metric",
  accentColor: "#ff2d8e",
  previewMock: true,
  panelStyle: "flat",
  vr: { ...DEFAULT_VR_SETTINGS },
};

/** Extract the backend-facing `VrGlobals` from the settings. */
export function vrGlobalsOf(vr: VrSettings): VrGlobals {
  return { distanceM: vr.distanceM, scale: vr.scale, curvature: vr.curvature, headLocked: vr.headLocked };
}

let settings: AppSettings = { ...DEFAULT_SETTINGS };
let loaded = false;
const listeners = new Set<() => void>();

// Units render in the widgets (overlay window), but the toggle lives in the
// manager window — a separate JS context with its own store. The sync module
// wires this broadcaster so a change propagates across windows.
let unitsBroadcaster: ((u: UnitSystem) => void) | null = null;
let previewMockBroadcaster: ((on: boolean) => void) | null = null;
let panelStyleBroadcaster: ((s: PanelStyle) => void) | null = null;

function emit() {
  settings = { ...settings };
  listeners.forEach((l) => l());
}

/** Shape-check a parsed settings blob field-by-field so a corrupt/hand-edited
 *  file degrades to defaults per-field instead of poisoning the whole object
 *  (e.g. `JSON.parse` happily returns `{}` or an array, and any field could be
 *  the wrong type). */
function sanitizeSettings(parsed: unknown): AppSettings {
  const p = (parsed && typeof parsed === "object" ? (parsed as Partial<AppSettings>) : {}) as Partial<AppSettings>;
  const vr = (p.vr && typeof p.vr === "object" ? (p.vr as Partial<VrSettings>) : {}) as Partial<VrSettings>;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return {
    editHotkey: typeof p.editHotkey === "string" && p.editHotkey ? p.editHotkey : DEFAULT_SETTINGS.editHotkey,
    autoShow: typeof p.autoShow === "boolean" ? p.autoShow : DEFAULT_SETTINGS.autoShow,
    monitorIndex: finite(p.monitorIndex) ? p.monitorIndex : null,
    units: p.units === "metric" || p.units === "imperial" ? p.units : DEFAULT_SETTINGS.units,
    accentColor: typeof p.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(p.accentColor) ? p.accentColor : DEFAULT_SETTINGS.accentColor,
    previewMock: typeof p.previewMock === "boolean" ? p.previewMock : DEFAULT_SETTINGS.previewMock,
    panelStyle: p.panelStyle === "flat" || p.panelStyle === "liquid" ? p.panelStyle : DEFAULT_SETTINGS.panelStyle,
    vr: {
      enabled: typeof vr.enabled === "boolean" ? vr.enabled : DEFAULT_VR_SETTINGS.enabled,
      backend: vr.backend === "auto" || vr.backend === "openvr" || vr.backend === "openxr" ? vr.backend : DEFAULT_VR_SETTINGS.backend,
      distanceM: finite(vr.distanceM) ? vr.distanceM : DEFAULT_VR_SETTINGS.distanceM,
      scale: finite(vr.scale) ? vr.scale : DEFAULT_VR_SETTINGS.scale,
      curvature: finite(vr.curvature) ? vr.curvature : DEFAULT_VR_SETTINGS.curvature,
      headLocked: typeof vr.headLocked === "boolean" ? vr.headLocked : DEFAULT_VR_SETTINGS.headLocked,
    },
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Write current settings to disk; a failure is logged and retried once so a
 *  transient FS error doesn't silently revert preferences on next launch. */
function persistNow() {
  const data = JSON.stringify(settings);
  saveSettings(data).catch((err) => {
    console.error("Settings save failed, retrying once:", err);
    saveSettings(data).catch((err2) => console.error("Settings save retry failed — changes may not persist:", err2));
  });
}
function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 300);
}

export const settingsStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get(): AppSettings {
    return settings;
  },
  isLoaded(): boolean {
    return loaded;
  },

  /** Load persisted settings and apply them to the backend. */
  async init() {
    const raw = await loadSettings();
    if (raw) {
      try {
        settings = sanitizeSettings(JSON.parse(raw));
      } catch {
        /* keep defaults */
      }
    }
    loaded = true;
    emit();
    // Push saved prefs to the backend so the live app matches.
    await controls.setEditHotkey(settings.editHotkey).catch(() => {});
    await controls.setAutoShow(settings.autoShow).catch(() => {});
    // Always apply, including null ("auto"), so a saved auto preference is
    // actually re-asserted on launch rather than left to whatever the backend
    // last happened to have.
    await controls.setOverlayMonitor(settings.monitorIndex).catch(() => {});
    // Re-arm VR if it was on (no-op / graceful error if the runtime isn't up).
    if (settings.vr.enabled) {
      await controls.vrSetEnabled(true, vrGlobalsOf(settings.vr), settings.vr.backend).catch(() => {});
    }
  },

  /** Turn the VR compositor on/off. Returns the backend message on failure so
   *  the UI can show "SteamVR not running" etc. */
  async setVrEnabled(enabled: boolean): Promise<string | null> {
    settings = { ...settings, vr: { ...settings.vr, enabled } };
    emit();
    schedulePersist();
    try {
      await controls.vrSetEnabled(enabled, vrGlobalsOf(settings.vr), settings.vr.backend);
      return null;
    } catch (e) {
      // Roll the toggle back so it reflects reality.
      settings = { ...settings, vr: { ...settings.vr, enabled: false } };
      emit();
      schedulePersist();
      return e instanceof Error ? e.message : String(e);
    }
  },

  setVrBackend(backend: VrBackendKind) {
    settings = { ...settings, vr: { ...settings.vr, backend } };
    emit();
    schedulePersist();
  },

  /** Update one or more VR placement values; pushes live if VR is running. */
  setVrGlobals(partial: Partial<VrGlobals>) {
    settings = { ...settings, vr: { ...settings.vr, ...partial } };
    emit();
    schedulePersist();
    if (settings.vr.enabled) void controls.vrSetGlobals(vrGlobalsOf(settings.vr)).catch(() => {});
  },

  /** Register the new hotkey with the backend *before* persisting/applying it
   *  locally — if the accelerator is already taken (or otherwise invalid), the
   *  old hotkey stays in effect and this returns the backend's error message
   *  for the UI to show. Returns null on success. */
  async setEditHotkey(accel: string): Promise<string | null> {
    try {
      await controls.setEditHotkey(accel);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    settings = { ...settings, editHotkey: accel };
    emit();
    schedulePersist();
    return null;
  },

  async setAutoShow(enabled: boolean) {
    settings = { ...settings, autoShow: enabled };
    emit();
    schedulePersist();
    await controls.setAutoShow(enabled).catch(() => {});
  },

  async setMonitorIndex(index: number | null) {
    settings = { ...settings, monitorIndex: index };
    emit();
    schedulePersist();
    // Always call — null ("Auto") must apply immediately too, not just on restart.
    await controls.setOverlayMonitor(index).catch(() => {});
  },

  /** Display units (metric/imperial) — widgets read it live; synced cross-window. */
  setUnits(units: UnitSystem) {
    settings = { ...settings, units };
    emit();
    schedulePersist();
    unitsBroadcaster?.(units);
  },

  /** Accent color for the manager UI (hex). Persisted; the manager applies it as
   *  CSS variables (see `ManagerApp`). */
  setAccentColor(hex: string) {
    settings = { ...settings, accentColor: hex };
    emit();
    schedulePersist();
  },

  // --- cross-window units sync (wired by the sync module in Tauri) ---
  setUnitsBroadcaster(fn: ((u: UnitSystem) => void) | null) {
    unitsBroadcaster = fn;
  },
  /** Apply a units change received from another window (no persist / re-broadcast). */
  applyUnits(units: UnitSystem) {
    if (settings.units === units) return;
    settings = { ...settings, units };
    emit();
  },
  /** Load just the persisted units (used by the overlay window, which doesn't run `init`). */
  async loadUnits() {
    const raw = await loadSettings();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      if (parsed.units) this.applyUnits(parsed.units);
    } catch {
      /* ignore */
    }
  },

  // --- cross-window preview-mock sync (same pattern as units) ---

  /** Toggle synthetic data in preview; synced cross-window so the overlay reacts live. */
  setPreviewMock(on: boolean) {
    settings = { ...settings, previewMock: on };
    emit();
    schedulePersist();
    previewMockBroadcaster?.(on);
  },
  setPreviewMockBroadcaster(fn: ((on: boolean) => void) | null) {
    previewMockBroadcaster = fn;
  },
  /** Apply a preview-mock change received from another window (no persist / re-broadcast). */
  applyPreviewMock(on: boolean) {
    if (settings.previewMock === on) return;
    settings = { ...settings, previewMock: on };
    emit();
  },
  /** Load just the persisted preview-mock flag (overlay window doesn't run `init`). */
  async loadPreviewMock() {
    const raw = await loadSettings();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      if (typeof parsed.previewMock === "boolean") this.applyPreviewMock(parsed.previewMock);
    } catch {
      /* ignore */
    }
  },

  // --- cross-window panel-style sync (same pattern as units) ---

  /** Set the widget panel style; synced cross-window so the overlay restyles live. */
  setPanelStyle(s: PanelStyle) {
    settings = { ...settings, panelStyle: s };
    emit();
    schedulePersist();
    panelStyleBroadcaster?.(s);
  },
  setPanelStyleBroadcaster(fn: ((s: PanelStyle) => void) | null) {
    panelStyleBroadcaster = fn;
  },
  /** Apply a panel-style change received from another window (no persist / re-broadcast). */
  applyPanelStyle(s: PanelStyle) {
    if (settings.panelStyle === s) return;
    settings = { ...settings, panelStyle: s };
    emit();
  },
  /** Load just the persisted panel style (overlay window doesn't run `init`). */
  async loadPanelStyle() {
    const raw = await loadSettings();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      if (parsed.panelStyle === "flat" || parsed.panelStyle === "liquid") this.applyPanelStyle(parsed.panelStyle);
    } catch {
      /* ignore */
    }
  },
};

export function useSettings(): AppSettings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
}
