// Control surface for the overlay — thin wrappers over the Rust commands, with
// browser fallbacks so the manager UI works in `npm run dev` (no backend).
//
// In Tauri these invoke backend commands; the backend owns the authoritative
// state and echoes it back via `overlay://status`. In a plain browser we update
// the local stores directly so the dev preview overlay shows/hides immediately.

import { isTauri } from "./transport";
import { editModeStore } from "./editMode";
import { statusStore, vrStatusStore, type OverlayStatus, type VrStatus } from "./session";

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
}

/** Global VR placement controls (mirrors Rust `VrGlobals`, camelCase). */
export interface VrGlobals {
  distanceM: number;
  scale: number;
  curvature: number;
  headLocked: boolean;
}

/** One widget's panel rectangle (physical px) + depth (mirrors Rust `VrWidget`). */
export interface VrWidgetLayout {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depthM: number;
}

export type VrBackendKind = "auto" | "openvr" | "openxr";

async function cmd<T = void>(name: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!isTauri()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(name, args);
}

/** Browser-only: recompute the synthetic overlay visibility from local flags. */
function browserReconcile() {
  const s = statusStore.get();
  statusStore.set({ overlayVisible: s.editing || s.preview || s.sessionActive });
}

export const controls = {
  async setEdit(editing: boolean): Promise<void> {
    if (isTauri()) {
      await cmd("set_edit", { editing });
      return;
    }
    // Edit is independent of preview: leaving edit with no session and no preview
    // hides the overlay (widgets shouldn't linger after you're done).
    editModeStore.set(editing);
    statusStore.set({ editing });
    browserReconcile();
  },

  async toggleEdit(): Promise<void> {
    await this.setEdit(!statusStore.get().editing);
  },

  async setPreview(enabled: boolean): Promise<void> {
    if (isTauri()) {
      await cmd("set_preview", { enabled });
      return;
    }
    statusStore.set({ preview: enabled });
    browserReconcile();
  },

  async setAutoShow(enabled: boolean): Promise<void> {
    await cmd("set_auto_show", { enabled });
  },

  async setEditHotkey(accel: string): Promise<void> {
    await cmd("set_edit_hotkey", { accel });
  },

  async listMonitors(): Promise<MonitorInfo[]> {
    if (!isTauri()) return [];
    return (await cmd<MonitorInfo[]>("list_monitors")) ?? [];
  },

  /** `null` = auto (the backend picks the secondary monitor). */
  async setOverlayMonitor(index: number | null): Promise<void> {
    await cmd("set_overlay_monitor", { index });
  },

  /** Pull the current backend status once (on manager load). */
  async fetchStatus(): Promise<void> {
    const s = await cmd<OverlayStatus>("get_status");
    if (s) statusStore.set(s);
  },

  // --- VR compositor ---

  /** Enable/disable the VR compositor. Returns the resulting status (or throws
   *  the backend message, e.g. "SteamVR not running"). */
  async vrSetEnabled(enabled: boolean, globals?: VrGlobals, backend?: VrBackendKind): Promise<VrStatus> {
    if (!isTauri()) {
      const s: VrStatus = { available: false, active: false, backend: "none", message: "VR needs the desktop app" };
      vrStatusStore.set(s);
      return s;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    const s = await invoke<VrStatus>("vr_set_enabled", { enabled, globals, backend });
    vrStatusStore.set(s);
    return s;
  },

  async vrSetGlobals(globals: VrGlobals): Promise<void> {
    await cmd("vr_set_globals", { globals });
  },

  async vrSetLayout(widgets: VrWidgetLayout[]): Promise<void> {
    await cmd("vr_set_layout", { widgets });
  },

  async vrRecenter(): Promise<void> {
    await cmd("vr_recenter");
  },

  async vrStatus(): Promise<VrStatus | undefined> {
    const s = await cmd<VrStatus>("vr_status");
    if (s) vrStatusStore.set(s);
    return s;
  },
};
