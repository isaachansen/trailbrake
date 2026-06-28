// Renders one widget instance: applies position/size/scale/opacity/visibility,
// and in edit mode provides drag-to-move, resize, and selection. The widget
// component itself stays purely presentational.

import { useRef } from "react";
import { layoutStore, type WidgetInstance } from "../store/layout";
import { getWidgetDef } from "../widgets/registry";
import { useSettings } from "../store/appSettings";
import { FitContent } from "./FitContent";
import { glassChrome, GLASS_SHADOW, GLASS_BORDER, GlassSpecular } from "./liquidGlass";
import type { Capabilities } from "../store/types";
import type { SessionStateKey } from "../store/sessionState";
import type { Theme } from "../theme/theme";

interface Props {
  instance: WidgetInstance;
  editing: boolean;
  selected: boolean;
  theme: Theme;
  caps: Capabilities | null;
  /** Current player session state for "Show overlay when …" gating; null=unknown. */
  sessionState: SessionStateKey | null;
}

export function WidgetHost({ instance, editing, selected, theme, caps, sessionState }: Props) {
  const def = getWidgetDef(instance.type);
  const dragRef = useRef<{ mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const panelStyle = useSettings().panelStyle;

  if (!def) return null;

  // Effective appearance: the instance's own value, or the global default when the
  // widget is set to inherit it ("Use general").
  const eff = layoutStore.getEffective(instance);

  // Opacity controls the *panel background* alpha — not element opacity — so text
  // and numbers stay fully crisp at any setting. 100% = a solid, readable panel
  // (the glass look comes from lowering it, not from a baked-in translucency).
  const panelAlpha = Math.max(0, Math.min(1, eff.opacity));
  const surfaceBg = `rgba(18, 20, 27, ${panelAlpha})`;

  // Some widgets paint only a screen-level effect (e.g. the Spotter set to
  // edges-only) and want no panel of their own. Outside edit mode we drop all
  // chrome so nothing shows; in edit mode the chrome stays so it's selectable.
  const chromeless = (def.transparentPanel?.(instance.config as any) ?? false) && !editing;
  // Liquid Glass panel style (opt-in via settings). Not for chromeless widgets.
  const glass = !chromeless && panelStyle === "liquid";

  // Capability-based hiding (§3): if the active sim can't feed this widget, hide
  // it entirely in race mode; in edit mode show a placeholder so the user knows.
  const missingCaps = def.requiredCapabilities.filter((c) => caps && !caps[c]);
  const unsupported = missingCaps.length > 0;

  // Session-state gating ("Show overlay when …"): only when we actually know the
  // state, so sims that don't report it never hide a widget. In edit mode
  // everything shows so it's editable.
  const hiddenByState = sessionState != null && !eff.showIn.includes(sessionState);

  if (!editing && (!instance.visible || unsupported || hiddenByState)) return null;

  const beginMove = (e: React.PointerEvent) => {
    if (!editing || instance.locked) return;
    layoutStore.select(instance.instanceId);
    dragRef.current = { mode: "move", sx: e.clientX, sy: e.clientY, ox: instance.position.x, oy: instance.position.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const beginResize = (e: React.PointerEvent) => {
    if (!editing || instance.locked) return;
    layoutStore.select(instance.instanceId);
    dragRef.current = { mode: "resize", sx: e.clientX, sy: e.clientY, ox: instance.size.w, oy: instance.size.h };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "move") {
      layoutStore.updateInstance(instance.instanceId, { position: { x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) } });
    } else {
      // Content-aware floor (tracks enabled columns × scale), so the handle stops
      // before the widget would clip/squish rather than at a fixed minimum.
      const min = layoutStore.minSizeFor(instance);
      layoutStore.updateInstance(instance.instanceId, {
        size: { w: Math.max(min.w, d.ox + dx), h: Math.max(min.h, d.oy + dy) },
      });
    }
  };
  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const Comp = def.Component;

  return (
    <div
      onPointerDown={editing ? () => layoutStore.select(instance.instanceId) : undefined}
      style={{
        position: "absolute",
        left: instance.position.x,
        top: instance.position.y,
        width: instance.size.w,
        height: instance.size.h,
        fontSize: theme.font.sizeBase * eff.scale,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: editing ? "auto" : "none",
        // Panel surface: flat glass (default) or Liquid Glass.
        ...(glass
          ? glassChrome(panelAlpha)
          : {
              background: chromeless ? "transparent" : surfaceBg,
              backdropFilter: chromeless ? "none" : theme.panelBlur,
              WebkitBackdropFilter: chromeless ? "none" : theme.panelBlur,
              borderRadius: theme.radius,
            }),
        border: editing
          ? `1px ${selected ? "solid" : "dashed"} ${selected ? theme.colors.edit : theme.colors.surfaceBorder}`
          : chromeless
            ? "none"
            : glass
              ? GLASS_BORDER
              : `1px solid ${theme.colors.surfaceBorder}`,
        // The selection ring only belongs in edit mode — never leave it on a widget
        // after "Done editing".
        boxShadow: editing && selected
          ? `${chromeless ? "none" : glass ? GLASS_SHADOW : theme.panelShadow}, 0 0 0 1px ${theme.colors.edit}`
          : chromeless
            ? "none"
            : glass
              ? GLASS_SHADOW
              : theme.panelShadow,
      }}
    >
      {glass && <GlassSpecular />}
      {editing && (
        <div
          onPointerDown={beginMove}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 8px",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            color: selected ? theme.colors.edit : theme.colors.textDim,
            background: "rgba(0,0,0,0.4)",
            cursor: instance.locked ? "not-allowed" : "move",
            flex: "0 0 auto",
          }}
        >
          <span>⠿</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{def.name}</span>
          {instance.locked && <span title="locked">🔒</span>}
          {missingCaps.length > 0 && <span title={`sim lacks: ${missingCaps.join(", ")}`} style={{ color: theme.colors.loss }}>!</span>}
          <button
            title="Remove widget"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              layoutStore.removeWidget(instance.instanceId);
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = theme.colors.loss;
              e.currentTarget.style.background = "rgba(255,73,94,0.18)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = theme.colors.textDim;
              e.currentTarget.style.background = "transparent";
            }}
            style={{
              flex: "0 0 auto",
              width: 18,
              height: 18,
              marginLeft: 2,
              display: "grid",
              placeItems: "center",
              border: "none",
              borderRadius: 4,
              background: "transparent",
              color: theme.colors.textDim,
              cursor: "pointer",
              font: `700 12px ${theme.font.family}`,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, flex: 1, minHeight: 0 }}>
        {unsupported ? (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: 8,
              boxSizing: "border-box",
              color: theme.colors.textDim,
              fontSize: 11,
            }}
          >
            Unavailable — this sim doesn't provide: {missingCaps.join(", ")}
          </div>
        ) : (
          <FitContent>
            {(size) => <Comp theme={theme} config={instance.config as any} caps={caps} size={size} />}
          </FitContent>
        )}
      </div>

      {editing && !instance.locked && (
        <div
          onPointerDown={beginResize}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          title="resize"
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 20,
            height: 20,
            cursor: "nwse-resize",
            // Above the content layer (which sits at zIndex 1 over the glass
            // specular) so the handle is actually grabbable, not covered.
            zIndex: 2,
            background: `linear-gradient(135deg, transparent 55%, ${selected ? theme.colors.edit : theme.colors.surfaceBorder} 55%)`,
          }}
        />
      )}
    </div>
  );
}
