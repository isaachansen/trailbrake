// "Software updates" settings card: a manual Check-for-updates button that, when
// a newer version is published, downloads + installs it in place and relaunches.
// All the moving parts live in store/updater.ts; this is just the UI around them.

import { useState } from "react";
import { Field } from "../ui";
import { isTauri } from "../../store/transport";
import {
  applyUpdate,
  checkForUpdate,
  updatesSupported,
  type DownloadProgress,
  type UpdateInfo,
} from "../../store/updater";

type Phase = "idle" | "checking" | "available" | "downloading" | "uptodate" | "error";

export function SoftwareUpdates() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState("");

  // No Tauri runtime (browser dev shell) → nothing to update.
  if (!updatesSupported()) {
    return (
      <div className="card">
        <div className="card-title">Software updates</div>
        <Field label="Current version">
          <span className="hint" style={{ flex: 1, fontFamily: "var(--mono, monospace)" }}>v{__APP_VERSION__}</span>
        </Field>
        <p className="hint">
          {isTauri()
            ? "Automatic updates aren't available in this build."
            : "Update checking is available in the desktop app."}
        </p>
      </div>
    );
  }

  async function check() {
    setPhase("checking");
    setError("");
    try {
      const found = await checkForUpdate();
      if (found) {
        setInfo(found);
        setPhase("available");
      } else {
        setPhase("uptodate");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function install() {
    setPhase("downloading");
    setError("");
    setProgress(null);
    try {
      // On success the app relaunches and this call never returns.
      await applyUpdate(setProgress);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  const busy = phase === "checking" || phase === "downloading";
  const pct = progress?.fraction != null ? Math.round(progress.fraction * 100) : null;

  return (
    <div className="card">
      <div className="card-title">Software updates</div>

      <Field label="Current version">
        <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
          <span className="hint" style={{ fontFamily: "var(--mono, monospace)" }}>v{__APP_VERSION__}</span>
          {phase !== "available" && phase !== "downloading" && (
            <button className="state-chip" onClick={() => void check()} disabled={busy}>
              {phase === "checking" ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
      </Field>

      {phase === "uptodate" && (
        <p className="hint">You're on the latest version.</p>
      )}

      {phase === "available" && info && (
        <>
          <p className="hint" style={{ marginTop: 2 }}>
            Version <b style={{ color: "var(--text)" }}>v{info.version}</b> is available.
            {info.notes ? (
              <span className="muted"> · {info.notes.trim().split("\n")[0]}</span>
            ) : null}
          </p>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="state-chip" onClick={() => setPhase("idle")}>Later</button>
            <button className="state-chip on" onClick={() => void install()}>Download &amp; install</button>
          </div>
        </>
      )}

      {phase === "downloading" && (
        <p className="hint">
          Downloading update{pct != null ? ` — ${pct}%` : "…"}
          <span className="muted"> · the app will restart when it's done.</span>
        </p>
      )}

      {phase === "error" && (
        <>
          <p className="hint" style={{ color: "var(--danger, #ff6b6b)" }}>Update failed: {error}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="state-chip" onClick={() => void check()}>Try again</button>
          </div>
        </>
      )}
    </div>
  );
}
