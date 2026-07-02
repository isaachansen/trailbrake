// Renders a widget definition live, fed by the mock-backed preview store, inside
// a panel that mimics the on-overlay widget chrome (glass surface + border). The
// widget is laid out at its native default size and scaled down to fit the box,
// so it looks exactly like it will on the overlay. Optionally renders a specific
// instance's config / opacity / scale so customization shows in real time.

import { useState } from "react";
import { defaultTheme } from "../theme/theme";
import { StoreProvider } from "../store/storeContext";
import { useCaps } from "../store/hooks";
import { useSettings } from "../store/appSettings";
import { ScreenLayerContext } from "../components/screenLayer";
import { FitContent } from "../components/FitContent";
import { glassChrome, GlassSpecular } from "../components/liquidGlass";
import { previewStoreFor } from "./previewStore";
import type { WidgetDefinition } from "../widgets/contract";

function PreviewInner({ def, config }: { def: WidgetDefinition; config: Record<string, unknown> }) {
  const caps = useCaps(); // reads the preview store via the provider below
  const Comp = def.Component;
  return <FitContent>{(size) => <Comp theme={defaultTheme} config={config} caps={caps} size={size} />}</FitContent>;
}

interface Props {
  def: WidgetDefinition;
  maxW: number;
  maxH: number;
  /** Override the widget's config (defaults to its defaultConfig). */
  config?: Record<string, unknown>;
  /** Panel opacity (matches the placed instance). */
  opacity?: number;
  /** Widget font/density multiplier (matches the placed instance's `scale`). */
  widgetScale?: number;
}

export function WidgetPreview({ def, maxW, maxH, config, opacity = 1, widgetScale = 1 }: Props) {
  const theme = defaultTheme;
  const { w, h } = def.defaultSize;
  const fit = Math.min(maxW / w, maxH / h, 1);
  const cfg = config ?? (def.defaultConfig as Record<string, unknown>);
  // Some widgets paint no panel of their own (e.g. Spotter in screen-edges-only
  // mode) — match the overlay and drop the glass chrome so the preview shows just
  // the effect, not an empty box.
  const transparent = def.transparentPanel?.(cfg) ?? false;
  // Call unconditionally — hooks must never be skipped by a short-circuit branch
  // (a transparent-panel widget still needs this hook to run every render).
  const panelStyle = useSettings().panelStyle;
  const glass = !transparent && panelStyle === "liquid";
  // Opacity mirrors the real host (WidgetHost.tsx): it's panel-*background* alpha,
  // never CSS element opacity — text and numbers must stay fully crisp at any
  // setting, matching what the user actually sees once placed.
  const panelAlpha = Math.max(0, Math.min(1, opacity));

  // Layer for screen-effect widgets (Spotter edge glow) to portal into. It must
  // represent the *screen*, not the widget's own (overflow-clipped) panel — so it
  // fills the preview stage around the widget rather than the panel box. The
  // scaler is left unpositioned so this absolutely-positioned layer attaches to
  // the nearest positioned ancestor (the `.preview-stage` / `.wcard-preview`
  // stage), letting edge effects pin to the simulated screen's sides.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);

  return (
    <div className="wp-scaler" style={{ width: Math.round(w * fit), height: Math.round(h * fit) }}>
      <div ref={setLayer} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0 }} />
      <div
        className="wp-panel"
        style={{
          width: w,
          height: h,
          transform: `scale(${fit})`,
          transformOrigin: "top left",
          fontSize: theme.font.sizeBase * widgetScale,
          ...(transparent
            ? {}
            : glass
              ? glassChrome(panelAlpha)
              : {
                  background: `rgba(18, 20, 27, ${panelAlpha})`,
                  border: `1px solid ${theme.colors.surfaceBorder}`,
                  borderRadius: theme.radius,
                  boxShadow: theme.panelShadow,
                  backdropFilter: theme.panelBlur,
                  WebkitBackdropFilter: theme.panelBlur,
                }),
        }}
      >
        {glass && <GlassSpecular />}
        <StoreProvider store={previewStoreFor(def.id)}>
          <ScreenLayerContext.Provider value={{ el: layer, preview: true, fullScreen: true }}>
            <div className="wp-body" style={{ position: "relative", zIndex: 1 }}>
              <PreviewInner def={def} config={cfg} />
            </div>
          </ScreenLayerContext.Provider>
        </StoreProvider>
      </div>
    </div>
  );
}
