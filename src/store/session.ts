// Overlay/session status, mirrored from the Rust backend's `overlay://status`
// events (and `get_status` on load). The manager UI reads this to drive the
// "Edit Overlay" button state and the status line. In a plain browser there's no
// backend, so `controls` updates this store directly for a live preview.

import { useSyncExternalStore } from "react";

export interface OverlayStatus {
  /** Telemetry is currently flowing — we're in a session. */
  sessionActive: boolean;
  /** Overlay is in edit mode (interactive). */
  editing: boolean;
  /** Overlay is being kept on screen manually (preview). */
  preview: boolean;
  /** Net result: is the overlay window currently visible. */
  overlayVisible: boolean;
  /** Active telemetry source label (mock / iracing / replay / auto). */
  source: string;
}

let status: OverlayStatus = {
  sessionActive: false,
  editing: false,
  preview: false,
  overlayVisible: false,
  source: "",
};

const listeners = new Set<() => void>();

export const statusStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get(): OverlayStatus {
    return status;
  },
  set(next: Partial<OverlayStatus>) {
    status = { ...status, ...next };
    listeners.forEach((l) => l());
  },
};

export function useStatus(): OverlayStatus {
  return useSyncExternalStore(statusStore.subscribe, statusStore.get);
}

// --- VR compositor status, mirrored from `overlay://vr-status` ---

export interface VrStatus {
  /** A VR backend is compiled in and a runtime is reachable. */
  available: boolean;
  /** The compositor is running and pushing per-widget panels. */
  active: boolean;
  /** Backend name ("OpenVR" / "OpenXR" / "none"). */
  backend: string;
  /** Last status / error message for display. */
  message: string;
}

let vrStatus: VrStatus = { available: false, active: false, backend: "none", message: "" };
const vrListeners = new Set<() => void>();

export const vrStatusStore = {
  subscribe(l: () => void): () => void {
    vrListeners.add(l);
    return () => vrListeners.delete(l);
  },
  get(): VrStatus {
    return vrStatus;
  },
  set(next: VrStatus) {
    vrStatus = next;
    vrListeners.forEach((l) => l());
  },
};

export function useVrStatus(): VrStatus {
  return useSyncExternalStore(vrStatusStore.subscribe, vrStatusStore.get);
}
