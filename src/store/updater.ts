// In-app auto-update client. A thin wrapper over the Tauri updater + process
// plugins so the rest of the app never imports them directly — that keeps the
// plain-browser dev build (which has no Tauri runtime) from trying to load the
// native-only modules. Everything here no-ops gracefully outside Tauri.
//
// Flow: checkForUpdate() hits the GitHub Releases `latest.json` manifest and
// returns the pending update (or null when we're already current). applyUpdate()
// downloads + verifies (minisign) + installs that update, reporting download
// progress, then relaunches into the new version.

import { isTauri } from "./transport";

export type UpdateInfo = {
  /** Version offered by the manifest, e.g. "0.2.0". */
  version: string;
  /** Version currently running. */
  currentVersion: string;
  /** Release notes from the manifest, if any. */
  notes?: string;
  /** Publish date from the manifest, if any. */
  date?: string;
};

export type DownloadProgress = {
  /** 0–1 once the total size is known, otherwise null (indeterminate). */
  fraction: number | null;
  downloaded: number;
  total: number | null;
};

// Holds the live Update handle between the check and the install so we don't
// re-fetch the manifest. Cleared once installed (or on a fresh check).
let pending: import("@tauri-apps/plugin-updater").Update | null = null;

/** Whether in-app updates can run (desktop app only, not the browser dev shell). */
export function updatesSupported(): boolean {
  return isTauri();
}

/** Check the release manifest. Returns the pending update, or null if current. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  // A previous check's Update handle (a Tauri Resource, backed by a Rust-side
  // allocation) is being discarded — release it before replacing `pending`
  // instead of leaking one per check.
  if (pending) await pending.close().catch(() => {});
  pending = update;
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body || undefined,
    date: update.date || undefined,
  };
}

/**
 * Download + install the update found by the last checkForUpdate(), then
 * relaunch. On success the app restarts and this never returns; it throws if no
 * update is pending or the download/verify/install fails.
 */
export async function applyUpdate(onProgress?: (p: DownloadProgress) => void): Promise<void> {
  if (!pending) throw new Error("No update is pending — check for updates first.");
  const update = pending;

  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress?.({ fraction: 0, downloaded: 0, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ fraction: total ? downloaded / total : null, downloaded, total });
        break;
      case "Finished":
        onProgress?.({ fraction: 1, downloaded, total });
        break;
    }
  });

  pending = null;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
