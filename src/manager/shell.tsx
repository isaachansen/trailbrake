// Manager chrome (Trailbrake v2): the left icon nav-rail and the topbar (page
// title + greeting, status pill, preview + edit actions). Reads the shared
// status store; the edit/preview toggles drive the backend via `controls`.

import { controls } from "../store/controls";
import { useStatus, type OverlayStatus } from "../store/session";
import { Icon, type IconName } from "./icons";

export type Page = "widgets" | "profiles" | "settings";

const NAV: { id: Page; label: string; icon: IconName }[] = [
  { id: "widgets", label: "Widgets", icon: "widgets" },
  { id: "profiles", label: "Profiles", icon: "layers" },
  { id: "settings", label: "Settings", icon: "settings" },
];

const PAGE_META: Record<Page, { title: string; sub: string }> = {
  widgets: { title: "Widgets", sub: "Toggle, preview and customize your overlay widgets." },
  profiles: { title: "Profiles", sub: "Save overlay layouts and switch between them per car." },
  settings: { title: "Settings", sub: "How and where the overlay appears." },
};

export function NavRail({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  return (
    <nav className="mgr-rail">
      <img className="rail-logo" src="/logo.png" alt="Trailbrake" />
      <div className="rail-nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item${page === item.id ? " active" : ""}`}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} className="nav-ico" />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

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
      <span className="dot" style={{ background: "#5f6573", boxShadow: "none" }} /> No session
    </span>
  );
}

export function TopBar({ page }: { page: Page }) {
  const status = useStatus();
  const meta = PAGE_META[page];
  return (
    <header className="mgr-topbar">
      <div>
        <h1 className="topbar-title">{meta.title}</h1>
        <div className="topbar-sub">{meta.sub}</div>
      </div>
      <div className="topbar-actions">
        <StatusPill status={status} />
        <button
          className={status.preview ? "btn btn-primary" : "btn btn-ghost"}
          onClick={() => void controls.setPreview(!status.preview)}
          title="Keep the overlay on screen outside of a session"
        >
          <Icon name="eye" size={16} />
          {status.preview ? "Preview on" : "Preview"}
        </button>
        <button
          className={`btn btn-primary${status.editing ? " is-active" : ""}`}
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
