// Configure the global edit-mode hotkey. Captures a real key chord, builds an
// accelerator string (e.g. "Ctrl+Shift+O") and hands it to the backend, which
// re-registers the global shortcut live.

import { useEffect, useState } from "react";
import { settingsStore, useSettings, DEFAULT_SETTINGS } from "../../store/appSettings";
import { isTauri } from "../../store/transport";

/** Map a KeyboardEvent to an accelerator key token, or null if not a usable key. */
function keyToken(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === "Space") return "Space";
  return null;
}

function Chips({ accel }: { accel: string }) {
  const parts = accel.split("+");
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span className="muted" style={{ fontSize: 12 }}>+</span>}
          <span className="kbd">{p}</span>
        </span>
      ))}
    </>
  );
}

export function HotkeysPage() {
  const settings = useSettings();
  const [capturing, setCapturing] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const tok = keyToken(e);
      if (!tok) return; // ignore pure modifier presses; wait for a real key
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      const accel = [...mods, tok].join("+");
      setCapturing(false);
      setWarn(mods.length === 0 ? "No modifier — this may clash with normal typing in games." : null);
      void settingsStore.setEditHotkey(accel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Hotkeys</h1>
          <p>Set the global shortcut that toggles overlay edit mode — works even while the game is focused.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Toggle edit mode</div>
        <div className="hotkey-capture">
          <div className={`hotkey-display${capturing ? " capturing" : ""}`}>
            {capturing ? "Press keys…" : <Chips accel={settings.editHotkey} />}
          </div>
          <button className={`btn${capturing ? " btn-primary" : ""}`} onClick={() => setCapturing((c) => !c)}>
            {capturing ? "Cancel" : "Change…"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setWarn(null);
              void settingsStore.setEditHotkey(DEFAULT_SETTINGS.editHotkey);
            }}
          >
            Reset to default
          </button>
        </div>
        {warn && (
          <div className="hint" style={{ marginTop: 10, color: "var(--warn)" }}>
            ⚠ {warn}
          </div>
        )}
        <div className="hint" style={{ marginTop: 12 }}>
          In edit mode the overlay becomes interactive — drag widgets to move them, drag a corner to resize.
          Press the hotkey again (or close edit mode here) to lock everything back into place.
          {!isTauri() && " In this browser preview, edit mode also toggles with the “e” key."}
        </div>
      </div>
    </div>
  );
}
