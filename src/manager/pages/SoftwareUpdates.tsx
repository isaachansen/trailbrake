// "Software updates" settings card: a manual Check-for-updates button that, when
// a newer version is published, downloads + installs it in place and relaunches.
// All the moving parts live in store/updater.ts; this is just the UI around them.

import { useSyncExternalStore } from "react";
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

interface UpdateFlowState {
  phase: Phase;
  info: UpdateInfo | null;
  progress: DownloadProgress | null;
  error: string;
}

// Hoisted to module scope (not component state): the Settings page can be
// navigated away from and back to mid-check/mid-download, and this is the
// single source of truth so that doesn't look like the flow silently reset.
// It also means a second `check()`/`install()` can't stomp on one already in
// flight — callers below check `state.phase` before starting either.
const updateFlow: UpdateFlowState = { phase: "idle", info: null, progress: null, error: "" };
const listeners = new Set<() => void>();

function setUpdateFlow(patch: Partial<UpdateFlowState>) {
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

async function check() {
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

async function install() {
  if (updateFlow.phase === "downloading") return;
  setUpdateFlow({ phase: "downloading", error: "", progress: null });
  try {
    // On success the app relaunches and this call never returns.
    await applyUpdate((p) => setUpdateFlow({ progress: p }));
  } catch (e) {
    setUpdateFlow({ error: e instanceof Error ? e.message : String(e), phase: "error" });
  }
}

export function SoftwareUpdates() {
  const { phase, info, progress, error } = useSyncExternalStore(subscribe, getSnapshot);

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
