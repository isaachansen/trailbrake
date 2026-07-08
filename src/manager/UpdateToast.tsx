// Startup "update available" toast. Unlike the Settings page's manual check
// (pages/SoftwareUpdates.tsx), this proactively checks shortly after boot and
// periodically thereafter, so a new release doesn't go unnoticed just because
// nobody opened Settings. Both surfaces read/drive the same state machine in
// store/updateFlow.ts, so installing (or an error) in one shows up in the
// other too.
//
// Portaled to document.body so it isn't clipped by the manager shell's
// overflow/stacking context and stays visible on every page.

import type { CSSProperties } from "react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { install, useUpdateFlow } from "../store/updateFlow";

export function UpdateToast({ themeStyle }: { themeStyle: CSSProperties }) {
  const { phase, info, progress, error } = useUpdateFlow();

  // Which version the user has already dismissed, so the periodic re-check
  // doesn't resurface the same offer every 4 hours. Kept local to the toast
  // (not in the shared store) so dismissing never hides the update from the
  // Settings card — that card has its own "Later" affordance.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const version = info?.version ?? null;
  const alreadyDismissed = version !== null && version === dismissedVersion;
  const visible =
    !alreadyDismissed &&
    info != null &&
    (phase === "available" || phase === "downloading" || phase === "error");
  if (!visible || !info) return null;

  const pct = progress?.fraction != null ? Math.round(progress.fraction * 100) : null;
  const title = phase === "downloading" ? "Downloading update" : phase === "error" ? "Update failed" : "Update available";

  return createPortal(
    <div className="update-toast-host" style={themeStyle}>
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
    </div>,
    document.body,
  );
}
