// Control surface for the overlay — thin wrappers over the Rust commands, with
// browser fallbacks so the manager UI works in `npm run dev` (no backend).
//
// In Tauri these invoke backend commands; the backend owns the authoritative
// state and echoes it back via `overlay://status`. In a plain browser we update
// the local stores directly so the dev preview overlay shows/hides immediately.

import { isTauri } from "./transport";
import { editModeStore } from "./editMode";
import { statusStore, type OverlayStatus } from "./session";

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
}

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

  async setOverlayMonitor(index: number): Promise<void> {
    await cmd("set_overlay_monitor", { index });
  },

  /** Pull the current backend status once (on manager load). */
  async fetchStatus(): Promise<void> {
    const s = await cmd<OverlayStatus>("get_status");
    if (s) statusStore.set(s);
  },
};
