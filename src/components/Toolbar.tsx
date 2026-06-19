// Edit-mode toolbar: manage layout profiles and add widgets. Saving is automatic
// (debounced) whenever the layout changes; this is the manual surface for the
// rest.

import { layoutStore } from "../store/layout";
import { allWidgetDefs } from "../widgets/registry";
import type { Theme } from "../theme/theme";

interface Props {
  theme: Theme;
  active: string;
  profiles: string[];
  /** Current car model (for per-car profile binding), or null. */
  carName: string | null;
  /** Profile currently bound to this car, if any. */
  boundProfile: string | null;
}

export function Toolbar({ theme, active, profiles, carName, boundProfile }: Props) {
  const selectStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.06)",
    color: theme.colors.text,
    border: `1px solid ${theme.colors.surfaceBorder}`,
    borderRadius: 4,
    padding: "3px 6px",
    fontSize: 12,
  };
  const btn: React.CSSProperties = {
    background: "transparent",
    border: `1px solid ${theme.colors.edit}`,
    color: theme.colors.edit,
    borderRadius: 4,
    padding: "3px 8px",
    fontSize: 12,
    cursor: "pointer",
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: "rgba(10,12,16,0.92)",
        border: `1px solid ${theme.colors.surfaceBorder}`,
        borderRadius: theme.radius,
        font: `600 12px ${theme.font.family}`,
        color: theme.colors.text,
        pointerEvents: "auto",
      }}
    >
      <span style={{ color: theme.colors.textDim }}>Profile</span>
      <select value={active} onChange={(e) => layoutStore.setActive(e.target.value)} style={selectStyle}>
        {profiles.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
      <button style={btn} onClick={() => {
        const name = window.prompt("New profile name");
        if (name) layoutStore.newProfile(name);
      }}>+ Profile</button>
      <button style={{ ...btn, borderColor: theme.colors.loss, color: theme.colors.loss }} onClick={() => {
        if (profiles.length > 1 && window.confirm(`Delete profile "${active}"?`)) layoutStore.deleteProfile(active);
      }}>Delete</button>
      <button style={{ ...btn, borderColor: theme.colors.surfaceBorder, color: theme.colors.textDim }} onClick={() => {
        if (window.confirm(`Reset "${active}" to the default layout?`)) layoutStore.resetProfile();
      }}>Reset</button>

      <span style={{ width: 1, height: 18, background: theme.colors.surfaceBorder }} />

      <span style={{ color: theme.colors.textDim }}>Add</span>
      <select value="" onChange={(e) => { if (e.target.value) { layoutStore.addWidget(e.target.value); e.target.value = ""; } }} style={selectStyle}>
        <option value="">widget…</option>
        {allWidgetDefs().map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>

      {carName && (
        <>
          <span style={{ width: 1, height: 18, background: theme.colors.surfaceBorder }} />
          {boundProfile === active ? (
            <button
              style={{ ...btn, borderColor: theme.colors.textDim, color: theme.colors.textDim }}
              title={`${carName} is bound to this profile`}
              onClick={() => layoutStore.unbindCar(carName)}
            >
              ✓ {carName} → unbind
            </button>
          ) : (
            <button style={btn} title={`Auto-switch to “${active}” when driving ${carName}`} onClick={() => layoutStore.bindCar(carName)}>
              Bind {carName} → {active}
            </button>
          )}
        </>
      )}
    </div>
  );
}
