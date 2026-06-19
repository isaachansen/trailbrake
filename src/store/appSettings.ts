// App-level settings (distinct from widget layout): the edit-mode hotkey,
// session auto-show, and which monitor the overlay lives on. Persisted to its
// own file (`app-settings.json` in Tauri, localStorage in the browser), and on
// load/change the relevant backend command is applied so the running app
// reflects the saved preferences.

import { useSyncExternalStore } from "react";
import { loadSettings, saveSettings } from "./persistence";
import { controls } from "./controls";
import type { UnitSystem } from "../widgets/format";

export interface AppSettings {
  /** Accelerator string for the edit-mode toggle, e.g. "Ctrl+Shift+O". */
  editHotkey: string;
  /** Auto-show the overlay when a session starts. */
  autoShow: boolean;
  /** Monitor index for the overlay, or null = auto (secondary monitor). */
  monitorIndex: number | null;
  /** Display units across all widgets (speed/fuel/temp). */
  units: UnitSystem;
}

export const DEFAULT_SETTINGS: AppSettings = {
  editHotkey: "Ctrl+Shift+O",
  autoShow: true,
  monitorIndex: null,
  units: "metric",
};

let settings: AppSettings = { ...DEFAULT_SETTINGS };
let loaded = false;
const listeners = new Set<() => void>();

// Units render in the widgets (overlay window), but the toggle lives in the
// manager window — a separate JS context with its own store. The sync module
// wires this broadcaster so a change propagates across windows.
let unitsBroadcaster: ((u: UnitSystem) => void) | null = null;

function emit() {
  settings = { ...settings };
  listeners.forEach((l) => l());
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSettings(JSON.stringify(settings)), 300);
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
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        settings = { ...DEFAULT_SETTINGS, ...parsed };
      } catch {
        /* keep defaults */
      }
    }
    loaded = true;
    emit();
    // Push saved prefs to the backend so the live app matches.
    await controls.setEditHotkey(settings.editHotkey).catch(() => {});
    await controls.setAutoShow(settings.autoShow).catch(() => {});
    if (settings.monitorIndex != null) {
      await controls.setOverlayMonitor(settings.monitorIndex).catch(() => {});
    }
  },

  async setEditHotkey(accel: string) {
    settings = { ...settings, editHotkey: accel };
    emit();
    schedulePersist();
    await controls.setEditHotkey(accel).catch(() => {});
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
    if (index != null) await controls.setOverlayMonitor(index).catch(() => {});
  },

  /** Display units (metric/imperial) — widgets read it live; synced cross-window. */
  setUnits(units: UnitSystem) {
    settings = { ...settings, units };
    emit();
    schedulePersist();
    unitsBroadcaster?.(units);
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
};

export function useSettings(): AppSettings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
}
