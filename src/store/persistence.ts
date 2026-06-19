// Layout/config persistence. In the Tauri app it goes through backend commands
// that write a JSON file in the app config dir; in a plain browser it falls back
// to localStorage so UI dev still persists.

import { isTauri } from "./transport";

const LS_KEY = "sim-overlay-config";
const LS_SETTINGS_KEY = "sim-overlay-settings";

export async function loadConfig(): Promise<string | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const data = await invoke<string | null>("load_overlay_config");
    return data ?? null;
  }
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

export async function saveConfig(data: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_overlay_config", { data });
    return;
  }
  try {
    localStorage.setItem(LS_KEY, data);
  } catch {
    /* ignore quota / disabled storage */
  }
}

export async function loadSettings(): Promise<string | null> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const data = await invoke<string | null>("load_app_settings");
    return data ?? null;
  }
  try {
    return localStorage.getItem(LS_SETTINGS_KEY);
  } catch {
    return null;
  }
}

export async function saveSettings(data: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_app_settings", { data });
    return;
  }
  try {
    localStorage.setItem(LS_SETTINGS_KEY, data);
  } catch {
    /* ignore quota / disabled storage */
  }
}
