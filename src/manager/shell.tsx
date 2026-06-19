// Manager chrome: header (brand + primary edit toggle + status pill), the left
// nav sidebar, and the bottom status bar. All read the shared status/layout
// stores; the edit toggle drives the backend via `controls`.

import { controls } from "../store/controls";
import { useStatus, type OverlayStatus } from "../store/session";
import { useSettings } from "../store/appSettings";
import { useLayout } from "../store/layout";
import { Icon, type IconName } from "./icons";

export type Page = "widgets" | "profiles" | "hotkeys" | "settings";

const NAV: { id: Page; label: string; icon: IconName }[] = [
  { id: "widgets", label: "Widgets", icon: "widgets" },
  { id: "profiles", label: "Profiles", icon: "layers" },
  { id: "hotkeys", label: "Hotkeys", icon: "keyboard" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function StatusPill({ status }: { status: OverlayStatus }) {
  if (status.editing) {
    return (
      <span className="pill edit">
        <span className="dot" /> Editing overlay
      </span>
    );
  }
  if (status.sessionActive) {
    return (
      <span className="pill live">
        <span className="dot" /> In session
      </span>
    );
  }
  return (
    <span className="pill">
      <span className="dot" /> Idle
    </span>
  );
}

export function HeaderBar() {
  const status = useStatus();
  return (
    <header className="mgr-header">
      <div className="brand">
        <img className="brand-mark" src="/logo.png" alt="Trailbrake" />
        <div className="brand-name">
          Trailbrake
          <small>telemetry hud</small>
        </div>
      </div>
      <div className="header-actions">
        <StatusPill status={status} />
        <button
          className={status.preview ? "btn btn-lg btn-primary" : "btn btn-lg btn-ghost"}
          onClick={() => void controls.setPreview(!status.preview)}
          title="Keep the overlay on screen outside of a session (click-through preview)"
        >
          <Icon name="eye" size={16} />
          {status.preview ? "Preview on" : "Preview"}
        </button>
        <button
          className={`btn btn-lg btn-primary${status.editing ? " is-active" : ""}`}
          onClick={() => void controls.setEdit(!status.editing)}
          title="Show the overlay and make widgets draggable"
        >
          <Icon name={status.editing ? "check" : "edit"} size={16} />
          {status.editing ? "Done editing" : "Edit overlay"}
        </button>
      </div>
    </header>
  );
}

export function Sidebar({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  const settings = useSettings();
  return (
    <nav className="sidebar">
      {NAV.map((item) => (
        <div
          key={item.id}
          className={`nav-item${page === item.id ? " active" : ""}`}
          onClick={() => onNavigate(item.id)}
        >
          <Icon name={item.icon} className="nav-ico" />
          {item.label}
        </div>
      ))}
      <div className="sidebar-foot">
        Edit hotkey
        <div style={{ marginTop: 5 }}>
          {settings.editHotkey.split("+").map((p, i) => (
            <span key={i}>
              {i > 0 && <span className="muted"> + </span>}
              <span className="kbd">{p}</span>
            </span>
          ))}
        </div>
      </div>
    </nav>
  );
}

export function StatusBar() {
  const status = useStatus();
  const layout = useLayout();

  const dotClass = status.editing ? "edit" : status.sessionActive ? "live" : "";
  const stateText = status.editing
    ? "Edit mode — overlay interactive"
    : status.sessionActive
      ? "In session — overlay live"
      : status.preview
        ? "Overlay shown (preview)"
        : "Waiting for a session";

  return (
    <footer className="statusbar">
      <span className={`sb-dot ${dotClass}`} />
      <span>{stateText}</span>
      <span className="spacer" />
      <span>
        Profile <b>{layout.active}</b>
      </span>
      <span className="muted">·</span>
      <span>
        Overlay <b>{status.overlayVisible ? "visible" : "hidden"}</b>
      </span>
    </footer>
  );
}
