// Renders one widget instance: applies position/size/scale/opacity/visibility,
// and in edit mode provides drag-to-move, resize, and selection. The widget
// component itself stays purely presentational.

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { layoutStore, type WidgetInstance } from "../store/layout";
import { getWidgetDef } from "../widgets/registry";
import { useSettings } from "../store/appSettings";
import { FitContent } from "./FitContent";
import { glassChrome, GLASS_SHADOW, GLASS_BORDER, GlassSpecular } from "./liquidGlass";
import type { Capabilities } from "../store/types";
import type { SessionStateKey } from "../store/sessionState";
import type { Theme } from "../theme/theme";

type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type DragState =
  | { mode: "move"; sx: number; sy: number; ox: number; oy: number }
  | { mode: "resize"; handle: ResizeHandle; sx: number; sy: number; startW: number; startH: number; startX: number; startY: number };

const RESIZE_CORNER = 20;
const RESIZE_EDGE = 8;

const RESIZE_HANDLES: { handle: ResizeHandle; cursor: string; style: React.CSSProperties }[] = [
  { handle: "nw", cursor: "nwse-resize", style: { top: 0, left: 0, width: RESIZE_CORNER, height: RESIZE_CORNER } },
  { handle: "ne", cursor: "nesw-resize", style: { top: 0, right: 0, width: RESIZE_CORNER, height: RESIZE_CORNER } },
  { handle: "sw", cursor: "nesw-resize", style: { bottom: 0, left: 0, width: RESIZE_CORNER, height: RESIZE_CORNER } },
  { handle: "se", cursor: "nwse-resize", style: { bottom: 0, right: 0, width: RESIZE_CORNER, height: RESIZE_CORNER } },
  { handle: "n", cursor: "ns-resize", style: { top: 0, left: RESIZE_CORNER, right: RESIZE_CORNER, height: RESIZE_EDGE } },
  { handle: "s", cursor: "ns-resize", style: { bottom: 0, left: RESIZE_CORNER, right: RESIZE_CORNER, height: RESIZE_EDGE } },
  { handle: "w", cursor: "ew-resize", style: { left: 0, top: RESIZE_CORNER, bottom: RESIZE_CORNER, width: RESIZE_EDGE } },
  { handle: "e", cursor: "ew-resize", style: { right: 0, top: RESIZE_CORNER, bottom: RESIZE_CORNER, width: RESIZE_EDGE } },
];

const RESIZE_HIGHLIGHT_W = 2.5;
/** Length of each arm on a corner L-highlight. */
const RESIZE_CORNER_ARM = 16;

/** Bold border segment for the hovered/active resize handle only — no permanent grips. */
function ResizeBorderHighlight({
  handle,
  color,
  radius,
}: {
  handle: ResizeHandle;
  color: string;
  radius: number;
}) {
  const base: React.CSSProperties = {
    position: "absolute",
    pointerEvents: "none",
    zIndex: 3,
    boxSizing: "border-box",
  };
  const edge: React.CSSProperties = { ...base, background: color, borderRadius: 1 };

  if (handle === "n") {
    return <div style={{ ...edge, top: 0, left: RESIZE_CORNER, right: RESIZE_CORNER, height: RESIZE_HIGHLIGHT_W }} aria-hidden />;
  }
  if (handle === "s") {
    return <div style={{ ...edge, bottom: 0, left: RESIZE_CORNER, right: RESIZE_CORNER, height: RESIZE_HIGHLIGHT_W }} aria-hidden />;
  }
  if (handle === "w") {
    return <div style={{ ...edge, left: 0, top: RESIZE_CORNER, bottom: RESIZE_CORNER, width: RESIZE_HIGHLIGHT_W }} aria-hidden />;
  }
  if (handle === "e") {
    return <div style={{ ...edge, right: 0, top: RESIZE_CORNER, bottom: RESIZE_CORNER, width: RESIZE_HIGHLIGHT_W }} aria-hidden />;
  }

  // Corner: L-shaped border following the panel radius.
  const corner: React.CSSProperties = {
    ...base,
    width: RESIZE_CORNER_ARM,
    height: RESIZE_CORNER_ARM,
    borderStyle: "solid",
    borderColor: color,
    borderWidth: 0,
  };
  if (handle === "nw") {
    Object.assign(corner, {
      top: 0,
      left: 0,
      borderTopWidth: RESIZE_HIGHLIGHT_W,
      borderLeftWidth: RESIZE_HIGHLIGHT_W,
      borderTopLeftRadius: radius,
    });
  } else if (handle === "ne") {
    Object.assign(corner, {
      top: 0,
      right: 0,
      borderTopWidth: RESIZE_HIGHLIGHT_W,
      borderRightWidth: RESIZE_HIGHLIGHT_W,
      borderTopRightRadius: radius,
    });
  } else if (handle === "sw") {
    Object.assign(corner, {
      bottom: 0,
      left: 0,
      borderBottomWidth: RESIZE_HIGHLIGHT_W,
      borderLeftWidth: RESIZE_HIGHLIGHT_W,
      borderBottomLeftRadius: radius,
    });
  } else {
    Object.assign(corner, {
      bottom: 0,
      right: 0,
      borderBottomWidth: RESIZE_HIGHLIGHT_W,
      borderRightWidth: RESIZE_HIGHLIGHT_W,
      borderBottomRightRadius: radius,
    });
  }
  return <div style={corner} aria-hidden />;
}

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
  const dragRef = useRef<DragState | null>(null);
  /** Active resize handle while dragging; null when idle. */
  const [resizeHandle, setResizeHandle] = useState<ResizeHandle | null>(null);
  /** Handle under the pointer — drives the bold border highlight. */
  const [hoverHandle, setHoverHandle] = useState<ResizeHandle | null>(null);
  const isResizing = resizeHandle != null;
  const highlightHandle = resizeHandle ?? hoverHandle;
  const panelStyle = useSettings().panelStyle;
  const hugContent = def?.hugContentHeight ?? false;
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const handleNaturalSize = useCallback((size: { w: number; h: number }) => {
    setNaturalSize((prev) => (prev?.w === size.w && prev?.h === size.h ? prev : size));
  }, []);
  // Stale hug-height from a prior measurement (e.g. empty store before mock data
  // arrives) must not pin the panel at a few pixels tall.
  useLayoutEffect(() => {
    setNaturalSize(null);
  }, [instance.instanceId, instance.size.w, instance.size.h]);

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
  const beginResize = (handle: ResizeHandle) => (e: React.PointerEvent) => {
    if (!editing || instance.locked) return;
    layoutStore.select(instance.instanceId);
    setResizeHandle(handle);
    dragRef.current = {
      mode: "resize",
      handle,
      sx: e.clientX,
      sy: e.clientY,
      startW: instance.size.w,
      startH: instance.size.h,
      startX: instance.position.x,
      startY: instance.position.y,
    };
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
      return;
    }

    const { handle } = d;
    const fromEast = handle === "e" || handle === "ne" || handle === "se";
    const fromWest = handle === "w" || handle === "nw" || handle === "sw";
    const fromSouth = handle === "s" || handle === "sw" || handle === "se";
    const fromNorth = handle === "n" || handle === "nw" || handle === "ne";

    let w = d.startW;
    let h = d.startH;
    if (fromEast) w = d.startW + dx;
    if (fromWest) w = d.startW - dx;
    if (fromSouth) h = d.startH + dy;
    if (fromNorth) h = d.startH - dy;

    // Content-aware floor (tracks enabled columns × scale), so the handle stops
    // before the widget would clip/squish rather than at a fixed minimum.
    const minSz = layoutStore.minSizeFor(instance);
    w = Math.max(minSz.w, w);
    h = Math.max(minSz.h, h);

    const partial: Partial<WidgetInstance> = { size: { w, h } };
    if (fromWest || fromNorth) {
      partial.position = {
        x: fromWest ? d.startX + d.startW - w : d.startX,
        y: fromNorth ? d.startY + d.startH - h : d.startY,
      };
      partial.position.x = Math.max(0, partial.position.x);
      partial.position.y = Math.max(0, partial.position.y);
    }
    layoutStore.updateInstance(instance.instanceId, partial);
  };
  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null;
    setResizeHandle(null);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  // A cancelled gesture (e.g. the OS/webview interrupts the pointer — alt-tab,
  // touch cancel, another element stealing capture) never fires pointerup, so
  // without this the drag/resize stays "live" and the next hover keeps moving
  // the widget. onLostPointerCapture also covers capture being released for any
  // other reason without an explicit endDrag call.
  const cancelDrag = () => {
    dragRef.current = null;
    setResizeHandle(null);
  };

  const Comp = def.Component;
  const min = layoutStore.minSizeFor(instance);
  const contentH = naturalSize
    ? Math.max(min.h, Math.min(naturalSize.h, instance.size.h))
    : instance.size.h;
  const chromeH = hugContent ? (isResizing ? instance.size.h : contentH) : instance.size.h;
  const dualBorder = hugContent && editing;

  const panelSurface = glass
    ? glassChrome(panelAlpha)
    : {
        background: chromeless ? "transparent" : surfaceBg,
        backdropFilter: chromeless ? "none" : theme.panelBlur,
        WebkitBackdropFilter: chromeless ? "none" : theme.panelBlur,
        borderRadius: theme.radius,
      };
  const panelBorder = chromeless
    ? "none"
    : glass
      ? GLASS_BORDER
      : `1px solid ${theme.colors.surfaceBorder}`;
  const panelShadow = chromeless ? "none" : glass ? GLASS_SHADOW : theme.panelShadow;
  const editBorder = editing
    ? `1px ${selected ? "solid" : "dashed"} ${selected ? theme.colors.edit : theme.colors.surfaceBorder}`
    : panelBorder;
  const editShadow =
    editing && selected
      ? `${chromeless ? "none" : glass ? GLASS_SHADOW : theme.panelShadow}, 0 0 0 1px ${theme.colors.edit}`
      : panelShadow;
  const innerBorder = dualBorder
    ? chromeless
      ? "none"
      : `1px solid ${selected ? theme.colors.edit : theme.colors.surfaceBorder}`
    : editBorder;
  const innerShadow = dualBorder ? (selected && !chromeless ? theme.panelShadow : "none") : editShadow;
  const allocBorder = dualBorder
    ? `1px dashed ${selected ? theme.colors.edit : theme.colors.surfaceBorder}`
    : undefined;

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
          boxSizing: "border-box",
          pointerEvents: editing ? "auto" : "none",
          ...(dualBorder && {
            border: allocBorder,
            borderRadius: theme.radius,
            boxShadow: selected ? `0 0 0 1px ${theme.colors.edit}33` : undefined,
          }),
        }}
      >
        <div
          style={{
            width: "100%",
            height: chromeH,
            fontSize: theme.font.sizeBase * eff.scale,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            ...panelSurface,
            border: innerBorder,
            boxShadow: innerShadow,
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
            <FitContent onNaturalSize={hugContent ? handleNaturalSize : undefined}>
              {(size) => (
                <Comp
                  theme={theme}
                  config={instance.config as any}
                  caps={caps}
                  size={size}
                  {...(hugContent ? { allocatedSize: { w: instance.size.w, h: instance.size.h } } : {})}
                />
              )}
            </FitContent>
          )}
          </div>
        </div>

        {editing && !instance.locked && (
          <>
            {RESIZE_HANDLES.map(({ handle, cursor, style }) => (
              <div
                key={handle}
                onPointerDown={beginResize(handle)}
                onPointerMove={onMove}
                onPointerUp={endDrag}
                onPointerCancel={cancelDrag}
                onLostPointerCapture={cancelDrag}
                onPointerEnter={() => setHoverHandle(handle)}
                onPointerLeave={() => setHoverHandle((h) => (h === handle ? null : h))}
                title="Resize"
                style={{
                  position: "absolute",
                  boxSizing: "border-box",
                  cursor,
                  // Above the content layer (which sits at zIndex 1 over the glass
                  // specular) so handles are actually grabbable, not covered.
                  zIndex: 2,
                  ...style,
                }}
              />
            ))}
            {highlightHandle && (
              <ResizeBorderHighlight
                handle={highlightHandle}
                color={selected ? theme.colors.edit : theme.colors.textDim}
                radius={theme.radius}
              />
            )}
          </>
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
            background: theme.colors.surface,
            backdropFilter: theme.panelBlur,
            WebkitBackdropFilter: theme.panelBlur,
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
