// Startup "update available" toast. Unlike the Settings page's manual check
// (pages/SoftwareUpdates.tsx), this proactively checks shortly after boot and
// periodically thereafter, so a new release doesn't go unnoticed just because
// nobody opened Settings. Both surfaces read/drive the same state machine in
// store/updateFlow.ts, so installing (or an error) in one shows up in the
// other too.

import { useEffect, useState } from "react";
import { isTauri } from "../store/transport";
import { updatesSupported } from "../store/updater";
import { check, install, seedMockUpdateFromQuery, useUpdateFlow } from "../store/updateFlow";

const INITIAL_CHECK_DELAY_MS = 3000; // let boot (transport/layout/settings init) settle first
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Module-scoped so React.StrictMode's dev double-invoke of effects (or the
// toast ever mounting twice) doesn't fire two overlapping check loops.
let autoCheckStarted = false;

export function UpdateToast() {
  const { phase, info, progress, error } = useUpdateFlow();

  // Which version the user has already dismissed, so the periodic re-check
  // doesn't resurface the same offer every 4 hours. Kept local to the toast
  // (not in the shared store) so dismissing never hides the update from the
  // Settings card — that card has its own "Later" affordance.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    // Dev-only preview affordance for screenshots/UI review: seeds a fake
    // "update available" straight into the shared store. Only reachable in
    // the browser dev shell (never the packaged Tauri app).
    if (!isTauri() && seedMockUpdateFromQuery(window.location.search)) return;

    if (!updatesSupported() || autoCheckStarted) return;
    autoCheckStarted = true;

    // Deliberately no cleanup: the timers are one-shot-armed for the app's
    // lifetime (the guard above never resets), so tearing them down on
    // StrictMode's mount→cleanup→remount cycle would leave no check loop at
    // all — the re-run bails on the guard before re-arming.
    setTimeout(() => void check(), INITIAL_CHECK_DELAY_MS);
    setInterval(() => void check(), RECHECK_INTERVAL_MS);
  }, []);

  const version = info?.version ?? null;
  const alreadyDismissed = version !== null && version === dismissedVersion;
  const visible =
    !alreadyDismissed &&
    info != null &&
    (phase === "available" || phase === "downloading" || phase === "error");
  if (!visible || !info) return null;

  const pct = progress?.fraction != null ? Math.round(progress.fraction * 100) : null;
  const title = phase === "downloading" ? "Downloading update" : phase === "error" ? "Update failed" : "Update available";

  return (
    <div className="update-toast" role="status">
      <div className="update-toast-head">
        <div className="update-toast-title">{title}</div>
        <button
          className="update-toast-close"
          aria-label="Dismiss"
          onClick={() => setDismissedVersion(info.version)}
        >
          ✕
        </button>
      </div>

      <p className="update-toast-version">
        <b>Trailbrake v{info.version}</b>
        <span className="muted"> · you're on v{info.currentVersion}</span>
      </p>

      {info.notes && phase === "available" && (
        <p className="update-toast-notes">{info.notes.trim().split("\n")[0]}</p>
      )}

      {phase === "available" && (
        <div className="update-toast-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void install()}>Update now</button>
        </div>
      )}

      {phase === "downloading" && (
        <>
          <div className="update-toast-progress-track">
            <div
              className={`update-toast-progress-bar${pct == null ? " indeterminate" : ""}`}
              style={pct != null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <p className="hint update-toast-hint">
            {pct != null ? `${pct}% downloaded` : "Downloading…"}
            <span className="muted"> · the app will restart when it's done.</span>
          </p>
        </>
      )}

      {phase === "error" && (
        <>
          <p className="hint error update-toast-hint">{error}</p>
          <div className="update-toast-actions">
            <button className="btn btn-sm" onClick={() => void install()}>Try again</button>
          </div>
        </>
      )}
    </div>
  );
}
