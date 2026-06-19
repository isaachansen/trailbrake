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
