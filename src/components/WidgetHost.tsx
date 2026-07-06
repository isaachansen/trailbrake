// Renders one widget instance: applies position/size/scale/opacity/visibility,
// and in edit mode provides drag-to-move, resize, and selection. The widget
// component itself stays purely presentational.

import { memo, useRef } from "react";
import { layoutStore, type WidgetInstance } from "../store/layout";
import { getWidgetDef } from "../widgets/registry";
import { useSettings } from "../store/appSettings";
import { isLiveOverlayWindow } from "../store/windowKind";
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

function WidgetHostImpl({ instance, editing, selected, theme, caps, sessionState }: Props) {
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
  // On the live overlay window we never apply backdrop-filter blur (see
  // isLiveOverlayWindow's doc comment: it can't sample the game behind a
  // different HWND, so it costs GPU for no visible effect). Floor the alpha
  // there so a low "glass" opacity setting doesn't read as a faint,
  // hard-edged tint with no blur to soften it — everywhere else the user's
  // chosen opacity is honored exactly.
  const isOverlayWindow = isLiveOverlayWindow();
  const effectiveAlpha = isOverlayWindow ? Math.max(panelAlpha, theme.overlayMinAlpha) : panelAlpha;
  const surfaceBg = `rgba(18, 20, 27, ${effectiveAlpha})`;

  // Some widgets paint only a screen-level effect (e.g. the Spotter set to
  // edges-only) and want no panel of their own. Outside edit mode we drop all
  // chrome so nothing shows; in edit mode the chrome stays so it's selectable.
  const chromeless = (def.transparentPanel?.(instance.config as any) ?? false) && !editing;
  // Liquid Glass panel style (opt-in via settings). Not for chromeless widgets,
  // and never on the live overlay window — its refraction+blur backdrop-filter
  // has the exact same "can't sample the game, costs GPU anyway" problem as
  // the flat glass blur, only heavier. Falls back to the (now non-blurred)
  // flat panel below; the setting still applies fully in the manager/gallery.
  const glass = !chromeless && !isOverlayWindow && panelStyle === "liquid";

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
  // A cancelled gesture (e.g. the OS/webview interrupts the pointer — alt-tab,
  // touch cancel, another element stealing capture) never fires pointerup, so
  // without this the drag/resize stays "live" and the next hover keeps moving
  // the widget. onLostPointerCapture also covers capture being released for any
  // other reason without an explicit endDrag call.
  const cancelDrag = () => {
    dragRef.current = null;
  };

  const Comp = def.Component;

  // The edit-mode title/close bar used to live *inside* the panel's flex column,
  // where its own rendered height ate into the content row's real height only
  // while editing — FitContent then measured the shrunk box and scaled every
  // widget down, so content visibly differed in and out of edit mode (issue 4e).
  // It now renders as a separate, absolutely-positioned "chip" that floats above
  // the panel's own bounds, so the panel (and therefore the content FitContent
  // measures) is always exactly `instance.size.{w,h}` regardless of `editing`.
  //
  // Height accounting for the floating chip (so the clamp math below is exact):
  // 18px remove button (its tallest child) + 4px top/bottom padding ×2 (8px) +
  // 1px top/bottom border ×2 (2px) = 28px.
  const EDIT_HEADER_H = 28;
  const EDIT_HEADER_GAP = 4; // visual breathing room between the chip and the panel

  return (
    <>
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
                backdropFilter: chromeless || isOverlayWindow ? "none" : theme.panelBlur,
                WebkitBackdropFilter: chromeless || isOverlayWindow ? "none" : theme.panelBlur,
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
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
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

      {/* Floating title/close chip — a sibling of the panel, NOT a child, so it
          never reserves space inside it (see the 4e note above). Positioned in
          the same coordinate space as the panel (both are absolute against
          `.overlay-root`), just above the panel's top edge. Clamped to 0 when
          the widget sits at (or near) the very top of the overlay, in which
          case it overlaps the panel's own top edge by up to EDIT_HEADER_H — a
          visual-only tradeoff (chrome painted over a sliver of content); it
          never changes the panel's box or what FitContent measures. */}
      {editing && (
        <div
          onPointerDown={beginMove}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={cancelDrag}
          style={{
            position: "absolute",
            left: instance.position.x,
            top: Math.max(0, instance.position.y - EDIT_HEADER_H - EDIT_HEADER_GAP),
            width: instance.size.w,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: theme.space.sm,
            padding: `${theme.space.xs}px ${theme.space.sm}px`,
            font: `600 11px ${theme.font.label}`,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: selected ? theme.colors.edit : theme.colors.textDim,
            background: isOverlayWindow ? surfaceBg : theme.colors.surface,
            backdropFilter: isOverlayWindow ? "none" : theme.panelBlur,
            WebkitBackdropFilter: isOverlayWindow ? "none" : theme.panelBlur,
            border: `1px solid ${selected ? theme.colors.edit : theme.colors.surfaceBorder}`,
            borderRadius: theme.radius / 2,
            boxShadow: theme.panelShadow,
            cursor: instance.locked ? "not-allowed" : "move",
            pointerEvents: "auto",
            transition: "color 120ms ease, border-color 120ms ease",
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
              borderRadius: theme.radius / 4,
              background: "transparent",
              color: theme.colors.textDim,
              cursor: "pointer",
              font: `700 12px ${theme.font.family}`,
              lineHeight: 1,
              transition: "color 120ms ease, background 120ms ease",
            }}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

/**
 * `OverlayApp` subscribes to `useSlow()`/`useCaps()` and re-renders at the
 * slow-path rate (~5 Hz). Without memoizing here, that re-render cascades into
 * re-running EVERY mounted widget's render function 5×/sec — including the
 * fast-path ones that never look at React props for their actual telemetry
 * (they read `store.latestFast`/`store.history` in their own `useRafDraw`
 * loop), so that work is pure waste.
 *
 * All the props below are either primitives or references that `OverlayApp`
 * only changes when something a widget could actually depend on changes:
 *  - `instance` — from `layoutStore`'s `widgets.map()`; unrelated widgets keep
 *    their exact object reference across a layout mutation (only the widget
 *    that was actually edited gets a new one), so this is a real signal.
 *  - `caps` — `store.getCaps()` returns the same object reference until the
 *    sim's capability set actually changes (rare — effectively once per
 *    session), even though `useCaps()` re-subscribes on every slow tick.
 *  - `theme` — a module-level constant (`defaultTheme`), always reference-equal.
 *  - `editing`, `selected`, `sessionState` — primitives, compared by value.
 *
 * Any of these becoming unequal must trigger a re-render, so the comparator
 * returns false (not equal → re-render) unless every one of them matches.
 */
function propsEqual(prev: Props, next: Props): boolean {
  return (
    prev.instance === next.instance &&
    prev.editing === next.editing &&
    prev.selected === next.selected &&
    prev.theme === next.theme &&
    prev.caps === next.caps &&
    prev.sessionState === next.sessionState
  );
}

export const WidgetHost = memo(WidgetHostImpl, propsEqual);
