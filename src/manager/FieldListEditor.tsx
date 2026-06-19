// Editor for a `fieldList` config option: an ordered, drag-reorderable list of
// info fields, each with an on/off toggle and per-session-type (race / qualy /
// practice) visibility checkboxes. Used by the Relative widget's header/footer.
//
// The stored value is an `InfoFieldConfig[]`; this component reconciles it with
// the widget's current catalog each render — preserving saved order, appending
// any newly-added catalog fields (off), and dropping fields no longer offered —
// so layouts saved before a field existed still pick it up.

import { useState } from "react";
import { SESSION_TYPES, reconcileFieldList, type InfoFieldConfig, type SessionType } from "../widgets/contract";
import { Toggle } from "./ui";

interface Catalog {
  key: string;
  label: string;
}

interface Props {
  label: string;
  catalog: Catalog[];
  value: InfoFieldConfig[] | undefined;
  onChange: (next: InfoFieldConfig[]) => void;
}

interface Row extends InfoFieldConfig {
  label: string;
}

const ALL: SessionType[] = SESSION_TYPES.map((s) => s.key);

export function FieldListEditor({ label, catalog, value, onChange }: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const labels = new Map(catalog.map((c) => [c.key, c.label]));
  const rows: Row[] = reconcileFieldList(value, catalog).map((e) => ({ ...e, label: labels.get(e.key)! }));

  const commit = (next: Row[]) => onChange(next.map(({ key, on, sessions }) => ({ key, on, sessions })));

  const setOn = (i: number, on: boolean) => commit(rows.map((r, j) => (j === i ? { ...r, on } : r)));

  const toggleSession = (i: number, s: SessionType) =>
    commit(
      rows.map((r, j) => {
        if (j !== i) return r;
        const has = r.sessions.includes(s);
        const sessions = has ? r.sessions.filter((x) => x !== s) : ALL.filter((x) => r.sessions.includes(x) || x === s);
        return { ...r, sessions };
      })
    );

  const drop = (to: number) => {
    if (drag === null || drag === to) {
      setDrag(null);
      setOver(null);
      return;
    }
    const next = [...rows];
    const [moved] = next.splice(drag, 1);
    next.splice(to, 0, moved);
    commit(next);
    setDrag(null);
    setOver(null);
  };

  return (
    <div className="fieldlist">
      <div className="fl-head">{label}</div>
      {rows.map((r, i) => (
        <div
          key={r.key}
          className={`fl-row${r.on ? " on" : ""}${over === i && drag !== null ? " over" : ""}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragEnd={() => {
            setDrag(null);
            setOver(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (over !== i) setOver(i);
          }}
          onDrop={() => drop(i)}
        >
          <span className="fl-handle" title="Drag to reorder" aria-hidden>
            ☰
          </span>
          <Toggle on={r.on} onChange={(v) => setOn(i, v)} title={r.on ? "Hide field" : "Show field"} />
          <span className="fl-label">{r.label}</span>
          <span className="fl-sessions">
            {SESSION_TYPES.map((s) => {
              const checked = r.sessions.includes(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  className={`fl-sess${checked ? " on" : ""}`}
                  onClick={() => toggleSession(i, s.key)}
                  title={`Show in ${s.label}`}
                >
                  <span className="fl-box" aria-hidden>
                    {checked ? "✓" : ""}
                  </span>
                  {s.label}
                </button>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}
