// The customization surface. One card per widget type — each shows a LIVE
// example (mock data) plus an on/off toggle (widgets are one-per-type, so the
// toggle adds/removes it from the active profile). Clicking a card opens a
// preview modal with the config controls beside it, updating in real time.

import { useEffect, useRef, useState } from "react";
import { layoutStore, useLayout, type Layout, type WidgetInstance } from "../../store/layout";
import { allWidgetDefs, getWidgetDef } from "../../widgets/registry";
import { useCaps } from "../../store/hooks";
import type { Capabilities } from "../../store/types";
import { Icon } from "../icons";
import { Toggle } from "../ui";
import { WidgetConfigEditor } from "../WidgetConfigEditor";
import { WidgetPreview } from "../WidgetPreview";
import { startPreviewMock } from "../previewStore";
import { widgetMeta } from "../widgetMeta";

const CAP_LABEL: Record<string, string> = {
  clutch: "clutch",
  steeringAngle: "steering",
  fuel: "fuel",
  deltas: "deltas",
  relativeGaps: "gaps",
  irating: "iRating",
  safetyRating: "license",
  multiclass: "multiclass",
  proximity: "proximity",
  trackMap: "track map",
};

function capChips(reqs: readonly string[], caps: Capabilities | null) {
  const missing = reqs.filter((c) => caps && !caps[c as keyof Capabilities]);
  if (missing.length === 0) return null;
  return (
    <div className="caps-badges">
      {missing.map((c) => (
        <span className="badge warn" key={c} title="The active sim may not provide this data">
          needs {CAP_LABEL[c] ?? c}
        </span>
      ))}
    </div>
  );
}

function instanceOfType(profile: Layout | undefined, type: string): WidgetInstance | null {
  return profile?.widgets.find((w) => w.type === type) ?? null;
}

export function WidgetsPage() {
  const layout = useLayout();
  const caps = useCaps();
  const defs = allWidgetDefs();
  const current = layout.profiles[layout.active];
  const [modalId, setModalId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  // Keep mock telemetry flowing into the preview store while this page is open.
  useEffect(() => startPreviewMock(), []);

  // Config modal: Escape-to-close, autofocus the first control on open, and a
  // basic Tab focus trap so keyboard users can't tab out into the page behind it.
  useEffect(() => {
    if (!modalId) return;
    const getFocusable = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => !el.hasAttribute("disabled"));
    // Defer to let the modal's contents mount before focusing.
    const t = window.setTimeout(() => getFocusable()[0]?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModalId(null);
        return;
      }
      if (e.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [modalId]);

  // One widget per type: toggling adds one instance or removes any of that type.
  const enable = (type: string) => layoutStore.addWidget(type);
  const disable = (type: string) => {
    (current?.widgets ?? [])
      .filter((w) => w.type === type)
      .forEach((w) => layoutStore.removeWidget(w.instanceId));
  };

  const modalDef = modalId ? getWidgetDef(modalId) : null;
  const modalMeta = modalDef ? widgetMeta(modalDef.id, modalDef.name) : null;
  const modalInst = modalDef ? instanceOfType(current, modalDef.id) : null;

  return (
    <div>
      <div className="widget-cards">
        {defs.map((def) => {
          const meta = widgetMeta(def.id, def.name);
          const inst = instanceOfType(current, def.id);
          const on = !!inst;
          const eff = inst ? layoutStore.getEffective(inst) : layoutStore.getDefaults();
          return (
            <div className={`wcard${on ? " on" : ""}`} key={def.id}>
              <div className="wcard-preview" onClick={() => setModalId(def.id)}>
                <WidgetPreview
                  def={def}
                  maxW={256}
                  maxH={170}
                  config={inst?.config}
                  opacity={eff.opacity}
                  widgetScale={eff.scale}
                />
                <span className="wcard-tag">
                  <Icon name="sliders" size={12} /> {on ? "Customize" : "Preview"}
                </span>
              </div>
              <div className="wcard-foot">
                <div className="mono-badge">{meta.monogram}</div>
                <div className="wcard-info">
                  <div className="cc-name">{def.name}</div>
                  <div className="cc-desc">{meta.description}</div>
                  {capChips(def.requiredCapabilities, caps)}
                </div>
                <Toggle on={on} onChange={(v) => (v ? enable(def.id) : disable(def.id))} title={on ? "Remove from overlay" : "Add to overlay"} />
              </div>
            </div>
          );
        })}
      </div>

      {modalDef && modalMeta && (
        <div className="modal-backdrop" onClick={() => setModalId(null)}>
          <div className="preview-modal wide" ref={modalRef} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <header className="preview-modal-head">
              <div className="row" style={{ gap: 12 }}>
                <div className="mono-badge">{modalMeta.monogram}</div>
                <div>
                  <div className="cc-name" style={{ fontSize: 17 }}>{modalDef.name}</div>
                  <div className="cc-desc">{modalMeta.description}</div>
                </div>
              </div>
              <button className="icon-btn" title="Close" onClick={() => setModalId(null)}>✕</button>
            </header>

            <div className="preview-modal-body">
              <div className="preview-stage">
                <WidgetPreview
                  def={modalDef}
                  maxW={440}
                  maxH={320}
                  config={modalInst?.config}
                  opacity={(modalInst ? layoutStore.getEffective(modalInst) : layoutStore.getDefaults()).opacity}
                  widgetScale={(modalInst ? layoutStore.getEffective(modalInst) : layoutStore.getDefaults()).scale}
                />
              </div>
              <div className="preview-controls">
                {modalInst ? (
                  <WidgetConfigEditor instance={modalInst} />
                ) : (
                  <div className="controls-empty">
                    <Icon name="sliders" size={22} />
                    <p className="hint">Add this widget to your overlay to customize it — opacity, scale, when it shows, and its own options.</p>
                  </div>
                )}
              </div>
            </div>

            <footer className="preview-modal-foot">
              {capChips(modalDef.requiredCapabilities, caps) ??
                (caps ? (
                  <span className="hint">Supported by the current source.</span>
                ) : (
                  <span className="hint">No sim connected — capabilities unknown.</span>
                ))}
              <div className="row" style={{ gap: 8 }}>
                {modalInst ? (
                  <button className="btn btn-danger" onClick={() => disable(modalDef.id)}>Remove</button>
                ) : (
                  <button className="btn btn-primary" onClick={() => enable(modalDef.id)}>
                    <Icon name="plus" size={15} /> Add to “{layout.active}”
                  </button>
                )}
                <button className="btn btn-ghost" onClick={() => setModalId(null)}>Done</button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
