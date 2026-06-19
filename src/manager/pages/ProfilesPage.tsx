// Layout profiles: switch / create / rename / delete / reset, plus per-car
// auto-switch bindings (drive car X → its bound profile loads automatically).

import { useState } from "react";
import { layoutStore, useLayout } from "../../store/layout";
import { useSlow } from "../../store/hooks";
import { Icon } from "../icons";

export function ProfilesPage() {
  const layout = useLayout();
  const carName = useSlow()?.carName ?? null;
  const profiles = layoutStore.listProfiles();

  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = () => {
    if (editing) layoutStore.renameProfile(editing, draft);
    setEditing(null);
  };

  const carBindings = Object.entries(layout.carProfiles);
  const boundToActive = carName ? layout.carProfiles[carName] === layout.active : false;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Profiles</h1>
          <p>Save different overlay layouts and switch between them — manually or automatically per car.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Layout profiles</div>
        {profiles.map((name) => {
          const active = name === layout.active;
          const widgets = layout.profiles[name]?.widgets.length ?? 0;
          return (
            <div className="list-row" key={name}>
              <div
                className={`radio-dot${active ? " on" : ""}`}
                role="radio"
                aria-checked={active}
                style={{ cursor: "pointer" }}
                onClick={() => layoutStore.setActive(name)}
              />
              <div className="lr-main">
                {editing === name ? (
                  <input
                    className="input"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <>
                    <div className="lr-name">
                      {name} {active && <span className="badge" style={{ marginLeft: 6 }}>active</span>}
                    </div>
                    <div className="lr-sub">{widgets} widget{widgets === 1 ? "" : "s"}</div>
                  </>
                )}
              </div>
              <div className="row-controls">
                {!active && (
                  <button className="btn btn-ghost btn-sm" onClick={() => layoutStore.setActive(name)}>
                    Use
                  </button>
                )}
                <button
                  className="icon-btn"
                  title="Rename"
                  onClick={() => {
                    setEditing(name);
                    setDraft(name);
                  }}
                >
                  <Icon name="edit" />
                </button>
                <button
                  className="icon-btn danger"
                  title="Delete profile"
                  disabled={profiles.length <= 1}
                  onClick={() => {
                    if (window.confirm(`Delete profile “${name}”?`)) layoutStore.deleteProfile(name);
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          );
        })}

        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="New profile name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) {
                layoutStore.newProfile(newName);
                setNewName("");
              }
            }}
          />
          <button
            className="btn btn-primary"
            disabled={!newName.trim()}
            onClick={() => {
              layoutStore.newProfile(newName);
              setNewName("");
            }}
          >
            <Icon name="plus" size={15} /> Create
          </button>
          <button
            className="btn btn-ghost"
            title="Reset the active profile to the default layout"
            onClick={() => {
              if (window.confirm(`Reset “${layout.active}” to the default layout?`)) layoutStore.resetProfile();
            }}
          >
            Reset active
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Per-car auto-switch</div>
        {carName ? (
          <div className="list-row">
            <div className="lr-main">
              <div className="lr-name">Currently driving: {carName}</div>
              <div className="lr-sub">
                {boundToActive
                  ? `Loads “${layout.active}” automatically.`
                  : `Bind this car to load “${layout.active}” when you drive it.`}
              </div>
            </div>
            {boundToActive ? (
              <button className="btn btn-ghost btn-sm" onClick={() => layoutStore.unbindCar(carName)}>
                Unbind
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => layoutStore.bindCar(carName)}>
                Bind → {layout.active}
              </button>
            )}
          </div>
        ) : (
          <div className="hint">No car detected yet. Jump in a session and the current car will appear here to bind.</div>
        )}

        {carBindings.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {carBindings.map(([car, profile]) => (
              <div className="list-row" key={car}>
                <div className="lr-main">
                  <div className="lr-name">{car}</div>
                  <div className="lr-sub">→ {profile}{layout.profiles[profile] ? "" : " (missing)"}</div>
                </div>
                <button className="icon-btn danger" title="Remove binding" onClick={() => layoutStore.unbindCar(car)}>
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
