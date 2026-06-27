// Wires a data source into the store. Two transports:
//
// - Tauri: subscribe to events the Rust backend emits (the real path), plus the
//   overlay status channel and cross-window layout sync.
// - Browser: run the JS mock (UI dev without the backend / on macOS).
//
// Detection is based on Tauri's injected internals, so the same bundle works in
// both a plain browser and inside the Tauri webview.
//
// `initTransport` is reference-counted so it can be called from both the manager
// and the overlay in the same browser context (the dev shell) without starting
// the mock twice.

import { store } from "./store";
import { editModeStore } from "./editMode";
import { statusStore, vrStatusStore } from "./session";
import { startBrowserMock } from "./mockSource";
import type { Capabilities, FastSample, SlowSample } from "./types";
import type { OverlayStatus, VrStatus } from "./session";

export const EVT_FAST = "telemetry://fast";
export const EVT_SLOW = "telemetry://slow";
export const EVT_CAPS = "telemetry://caps";
export const EVT_EDIT_MODE = "overlay://edit-mode";
export const EVT_STATUS = "overlay://status";
export const EVT_VR_STATUS = "overlay://vr-status";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let refCount = 0;
let activeCleanup: (() => void) | null = null;
let startPromise: Promise<void> | null = null;

async function start(): Promise<void> {
  if (!isTauri()) {
    const stopMock = startBrowserMock();
    activeCleanup = stopMock;
    return;
  }

  const { listen } = await import("@tauri-apps/api/event");
  const { initSync } = await import("./sync");

  const unlisteners = await Promise.all([
    listen<FastSample>(EVT_FAST, (e) => store.ingestFast(e.payload)),
    listen<SlowSample>(EVT_SLOW, (e) => store.ingestSlow(e.payload)),
    listen<Capabilities>(EVT_CAPS, (e) => store.setCaps(e.payload)),
    listen<boolean>(EVT_EDIT_MODE, (e) => editModeStore.set(e.payload)),
    listen<OverlayStatus>(EVT_STATUS, (e) => statusStore.set(e.payload)),
    listen<VrStatus>(EVT_VR_STATUS, (e) => vrStatusStore.set(e.payload)),
  ]);
  const stopSync = await initSync();

  activeCleanup = () => {
    unlisteners.forEach((un) => un());
    stopSync();
  };
}

/** Begin feeding the store. Returns a cleanup function (ref-counted). */
export async function initTransport(): Promise<() => void> {
  refCount += 1;
  if (refCount === 1) {
    startPromise = start();
  }
  await startPromise;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;
    if (refCount === 0) {
      activeCleanup?.();
      activeCleanup = null;
      startPromise = null;
    }
  };
}
