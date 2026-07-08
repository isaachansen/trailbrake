// Shared "is there an update, and what's happening with it" state machine.
// Both the Settings page's manual check (manager/pages/SoftwareUpdates.tsx)
// and the startup toast (manager/UpdateToast.tsx) read/drive this same store
// so the two surfaces never disagree about what's in flight — e.g. dismissing
// the toast must not make the Settings card forget an update is available,
// and clicking "Update now" in the toast must show up as downloading if the
// user then flips over to Settings.
//
// The actual check/download/install mechanics live in store/updater.ts; this
// module is just the state machine + React binding around them.

import { useSyncExternalStore } from "react";
import {
  applyUpdate,
  checkForUpdate,
  type DownloadProgress,
  type UpdateInfo,
  updatesSupported,
} from "./updater";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "uptodate" | "error";

export interface UpdateFlowState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: DownloadProgress | null;
  error: string;
}

const INITIAL_CHECK_DELAY_MS = 3000; // let boot (transport/layout/settings init) settle first
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Hoisted to module scope (not component state): either surface can be
// unmounted and remounted mid-check/mid-download (Settings page navigated
// away, or the toast dismissed) and this is the single source of truth so
// that doesn't look like the flow silently reset. It also means a second
// `check()`/`install()` can't stomp on one already in flight — callers below
// check `state.phase` before starting either.
const updateFlow: UpdateFlowState = { phase: "idle", info: null, progress: null, error: "" };
const listeners = new Set<() => void>();

export function setUpdateFlow(patch: Partial<UpdateFlowState>) {
  Object.assign(updateFlow, patch);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): UpdateFlowState {
  return updateFlow;
}

export async function check() {
  if (updateFlow.phase === "checking" || updateFlow.phase === "downloading") return;
  setUpdateFlow({ phase: "checking", error: "" });
  try {
    const found = await checkForUpdate();
    if (found) setUpdateFlow({ info: found, phase: "available" });
    else setUpdateFlow({ phase: "uptodate" });
  } catch (e) {
    setUpdateFlow({ error: e instanceof Error ? e.message : String(e), phase: "error" });
  }
}

export async function install() {
  if (updateFlow.phase === "downloading") return;
  setUpdateFlow({ phase: "downloading", error: "", progress: null });
  try {
    // On success the app relaunches and this call never returns.
    await applyUpdate((p) => setUpdateFlow({ progress: p }));
  } catch (e) {
    setUpdateFlow({ error: e instanceof Error ? e.message : String(e), phase: "error" });
  }
}

// Module-scoped so React.StrictMode's dev double-invoke of effects (or the
// manager ever mounting twice) doesn't fire two overlapping check loops.
let autoCheckStarted = false;

/** Arm the startup + periodic update checks. Call once from the manager shell. */
export function startAutoUpdateCheck(): void {
  if (!updatesSupported() || autoCheckStarted) return;
  autoCheckStarted = true;

  // Deliberately no teardown: the timers are one-shot-armed for the app's
  // lifetime (the guard above never resets), so tearing them down on
  // StrictMode's mount→cleanup→remount cycle would leave no check loop at
  // all — the re-run bails on the guard before re-arming.
  setTimeout(() => void check(), INITIAL_CHECK_DELAY_MS);
  setInterval(() => void check(), RECHECK_INTERVAL_MS);
}

/** React binding for the shared update-flow state. */
export function useUpdateFlow(): UpdateFlowState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------------------------------------------------------------------------
// Dev-only preview affordance. There's no way to trigger a real "update
// available" state without publishing a release, which makes the toast
// impossible to screenshot or eyeball during review. `?mockUpdate=0.3.0`
// (optionally `&mockPhase=downloading`) seeds this store with a fake
// UpdateInfo so the browser dev shell renders it. Never called from the
// packaged app — see the isTauri() guard at the call site in ManagerApp.tsx.
// ---------------------------------------------------------------------------
export function seedMockUpdateFromQuery(search: string): boolean {
  const params = new URLSearchParams(search);
  const version = params.get("mockUpdate");
  if (!version) return false;
  const downloading = params.get("mockPhase") === "downloading";
  setUpdateFlow({
    phase: downloading ? "downloading" : "available",
    info: {
      version,
      currentVersion: __APP_VERSION__,
      notes: "New: update toast, spotter polish, bug fixes",
    },
    progress: downloading ? { fraction: 0.42, downloaded: 42_000_000, total: 100_000_000 } : null,
    error: "",
  });
  return true;
}
