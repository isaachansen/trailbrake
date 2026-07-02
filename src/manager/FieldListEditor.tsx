// Editor for a `fieldList` config option: an ordered, drag-reorderable list of
// info fields, each with an on/off toggle and per-session-type (race / qualy /
// practice) visibility checkboxes. Used by the Relative widget's header/footer.
//
// The stored value is an `InfoFieldConfig[]`; this component reconciles it with
// the widget's current catalog each render — preserving saved order, appending
// any newly-added catalog fields (off), and dropping fields no longer offered —
// so layouts saved before a field existed still pick it up.
//
// Reordering is pointer-event driven (pointerdown + setPointerCapture), not
// HTML5 `draggable` — a `draggable` row with interactive children (the toggle,
// the session buttons) is notorious on Chromium/WebView2 for hijacking the
// click gesture into a native drag the moment the pointer moves a pixel while
// mousedown'd on a child, making buttons feel unresponsive. Scoping the drag
// gesture to a dedicated handle, with its own pointer capture, keeps the two
// interactions from ever competing for the same mousedown. Up/down buttons
// give keyboard/screen-reader users an equivalent, since pointer dragging
// alone isn't operable without a pointer.

import { useRef, useState } from "react";
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

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** In-progress pointer drag: captured once at pointerdown, read on every move. */
interface DragMeta {
  pointerId: number;
  startY: number;
  /** Distance between consecutive row tops (row height + gap), for translating
   *  pixel movement into "how many rows did we cross". */
  slot: number;
}

export function FieldListEditor({ label, catalog, value, onChange }: Props) {
  const labels = new Map(catalog.map((c) => [c.key, c.label]));
  const rows: Row[] = reconcileFieldList(value, catalog).map((e) => ({ ...e, label: labels.get(e.key)! }));

  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const dragMeta = useRef<DragMeta | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [dragY, setDragY] = useState(0);

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

  const moveRow = (i: number, dir: -1 | 1) => {
    const to = i + dir;
    if (to < 0 || to >= rows.length) return;
    commit(arrayMove(rows, i, to));
  };

  const endDrag = () => {
    dragMeta.current = null;
    setDragIdx(null);
    setOverIdx(null);
    setDragY(0);
  };

  const beginDrag = (e: React.PointerEvent, i: number) => {
    const rowEl = rowRefs.current[i];
    if (!rowEl) return;
    const rowHeight = rowEl.getBoundingClientRect().height;
    const next = rowRefs.current[i + 1];
    const slot = next ? next.getBoundingClientRect().top - rowEl.getBoundingClientRect().top : rowHeight + 5;
    dragMeta.current = { pointerId: e.pointerId, startY: e.clientY, slot: slot || rowHeight || 1 };
    setDragIdx(i);
    setOverIdx(i);
    setDragY(0);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onDragMove = (e: React.PointerEvent) => {
    const meta = dragMeta.current;
    if (!meta || dragIdx === null) return;
    const dy = e.clientY - meta.startY;
    setDragY(dy);
    const shift = Math.round(dy / meta.slot);
    const next = Math.max(0, Math.min(rows.length - 1, dragIdx + shift));
    if (next !== overIdx) setOverIdx(next);
  };

  const onDragUp = (e: React.PointerEvent) => {
    const meta = dragMeta.current;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (meta && dragIdx !== null && overIdx !== null && overIdx !== dragIdx) {
      commit(arrayMove(rows, dragIdx, overIdx));
    }
    endDrag();
  };

  const dragging = dragIdx !== null && overIdx !== null;
  const slot = dragMeta.current?.slot ?? 0;

  return (
    <div className="fieldlist">
      <div className="fl-head">{label}</div>
      {rows.map((r, i) => {
        const isDragged = dragging && i === dragIdx;
        let shift = 0;
        if (dragging && !isDragged && dragIdx !== null && overIdx !== null) {
          if (dragIdx < overIdx && i > dragIdx && i <= overIdx) shift = -1;
          else if (dragIdx > overIdx && i >= overIdx && i < dragIdx) shift = 1;
        }
        return (
          <div
            key={r.key}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            className={`fl-row${r.on ? " on" : ""}${isDragged ? " dragging" : ""}`}
            style={
              isDragged
                ? { transform: `translateY(${dragY}px)`, transition: "none", position: "relative", zIndex: 5 }
                : shift !== 0
                  ? { transform: `translateY(${shift * slot}px)`, transition: "transform 0.12s ease" }
                  : { transform: "translateY(0)", transition: "transform 0.12s ease" }
            }
          >
            <span
              className="fl-handle"
              title="Drag to reorder"
              aria-hidden
              onPointerDown={(e) => beginDrag(e, i)}
              onPointerMove={onDragMove}
              onPointerUp={onDragUp}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
            >
              ⠿
            </span>
            <span className="fl-reorder">
              <button
                type="button"
                className="fl-reorder-btn"
                disabled={i === 0}
                onClick={() => moveRow(i, -1)}
                title={`Move ${r.label} up`}
                aria-label={`Move ${r.label} up`}
              >
                ▲
              </button>
              <button
                type="button"
                className="fl-reorder-btn"
                disabled={i === rows.length - 1}
                onClick={() => moveRow(i, 1)}
                title={`Move ${r.label} down`}
                aria-label={`Move ${r.label} down`}
              >
                ▼
              </button>
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
                    aria-pressed={checked}
                    aria-label={s.label}
                    onClick={() => toggleSession(i, s.key)}
                    title={`${checked ? "Hide" : "Show"} in ${s.label}`}
                  >
                    {s.label[0].toUpperCase()}
                  </button>
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
