// "Software updates" settings card: a manual Check-for-updates button that, when
// a newer version is published, downloads + installs it in place and relaunches.
// The state machine lives in store/updateFlow.ts (shared with the startup toast
// in manager/UpdateToast.tsx); this is just the UI around it.

import { Field } from "../ui";
import { isTauri } from "../../store/transport";
import { updatesSupported } from "../../store/updater";
import { check, install, setUpdateFlow, useUpdateFlow } from "../../store/updateFlow";

export function SoftwareUpdates() {
  const { phase, info, progress, error } = useUpdateFlow();

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

  const busy = phase === "checking" || phase === "downloading";
  const pct = progress?.fraction != null ? Math.round(progress.fraction * 100) : null;

  return (
    <div className="card">
      <div className="card-title">Software updates</div>

      <Field label="Current version">
        <div className="row" style={{ flex: 1, justifyContent: "space-between" }}>
          <span className="hint" style={{ fontFamily: "var(--mono, monospace)" }}>v{__APP_VERSION__}</span>
          {phase !== "available" && phase !== "downloading" && (
            <button className="btn btn-sm" onClick={() => void check()} disabled={busy}>
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
            <button className="btn btn-ghost btn-sm" onClick={() => setUpdateFlow({ phase: "idle" })}>Later</button>
            <button className="btn btn-primary btn-sm" onClick={() => void install()}>Download &amp; install</button>
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
          <p className="hint error">Update failed: {error}</p>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-sm" onClick={() => void check()}>Try again</button>
          </div>
        </>
      )}
    </div>
  );
}
