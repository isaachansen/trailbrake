// Widget gallery — a screenshot-friendly view that renders widgets in isolation
// with believable mock data, so agents (and humans) can SEE every widget and
// judge its UI. Routed from `main.tsx` when the URL contains `?gallery`.
//
// Two modes, selected by URL:
//   ?gallery                       → contact sheet: every widget in a labeled grid
//   ?gallery&widget=<id>           → one widget, centered, for a clean per-widget shot
//
// Extra params (both modes):
//   bg=track|dark|light|checker    → backdrop the glass panels composite over
//   size=default|min|large         → which authored size to render the panel at
//   w=<px>&h=<px>                   → explicit panel size (overrides `size`)
//   scale=<n>                      → widget font/density multiplier (instance `scale`)
//   opacity=<0..1>                 → panel opacity (instance `opacity`)
//   config=<json>                  → JSON object merged over the widget's defaultConfig
//
// The capture script (`scripts/shoot-widgets.mjs`) reads `window.__WIDGETS__`
// for the registry list and screenshots the element marked `data-widget-shot`.

import { useEffect, useState, type ReactNode } from "react";
import { defaultTheme } from "../theme/theme";
import { StoreProvider } from "../store/storeContext";
import { useCaps } from "../store/hooks";
import { ScreenLayerContext } from "../components/screenLayer";
import { FitContent } from "../components/FitContent";
import { previewStoreFor, startPreviewMock } from "../manager/previewStore";
import { allWidgetDefs, getWidgetDef } from "../widgets/registry";
import { widgetMeta } from "../manager/widgetMeta";
import type { WidgetDefinition } from "../widgets/contract";

const theme = defaultTheme;

type BgKey = "track" | "dark" | "light" | "checker";

// Backdrops the glass widgets composite over. "track" approximates a gameplay
// scene (sky→asphalt) so translucency and screen-effect widgets read honestly;
// the others stress-test contrast on flat tones.
const BACKDROPS: Record<BgKey, string> = {
  track:
    "linear-gradient(180deg, #2a3340 0%, #3b4654 26%, #4a5360 40%, #2c3138 55%, #1c2026 75%, #14171c 100%)",
  dark: "#0c0e12",
  light: "#c9ced6",
  checker:
    "repeating-conic-gradient(#3a3f47 0% 25%, #2a2e35 0% 50%) 50% / 40px 40px",
};

function sizeFor(def: WidgetDefinition, mode: string, w?: number, h?: number) {
  if (w && h) return { w, h };
  if (mode === "min") return def.minSize;
  if (mode === "large")
    return { w: Math.round(def.defaultSize.w * 1.5), h: Math.round(def.defaultSize.h * 1.5) };
  return def.defaultSize;
}

function Inner({ def, config }: { def: WidgetDefinition; config: Record<string, unknown> }) {
  const caps = useCaps(); // reads the preview store via the provider
  const Comp = def.Component;
  return <FitContent>{(size) => <Comp theme={theme} config={config} caps={caps} size={size} />}</FitContent>;
}

/** One widget rendered at an explicit pixel size inside the exact overlay panel
 * chrome (glass surface + border), unless the widget paints a transparent panel. */
function GalleryPanel({
  def,
  w,
  h,
  opacity = 1,
  widgetScale = 1,
  config,
}: {
  def: WidgetDefinition;
  w: number;
  h: number;
  opacity?: number;
  widgetScale?: number;
  config?: Record<string, unknown>;
}) {
  const cfg = config ?? (def.defaultConfig as Record<string, unknown>);
  const transparent = def.transparentPanel?.(cfg) ?? false;
  // A layer OUTSIDE the clipped panel for screen-effect widgets (e.g. Spotter
  // edge glow) to portal into — mirrors WidgetPreview / the real overlay host.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);

  return (
    <div data-widget-shot style={{ width: w, height: h, position: "relative" }}>
      <div ref={setLayer} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0 }} />
      <div
        style={{
          width: w,
          height: h,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          color: theme.colors.text,
          fontSize: theme.font.sizeBase * widgetScale,
          fontFamily: theme.font.family,
          opacity,
          ...(transparent
            ? {}
            : {
                background: theme.colors.surface,
                border: `1px solid ${theme.colors.surfaceBorder}`,
                borderRadius: theme.radius,
                boxShadow: theme.panelShadow,
                backdropFilter: theme.panelBlur,
                WebkitBackdropFilter: theme.panelBlur,
              }),
        }}
      >
        <StoreProvider store={previewStoreFor(def.id)}>
          <ScreenLayerContext.Provider value={{ el: layer, preview: true, fullScreen: false }}>
            <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
              <Inner def={def} config={cfg} />
            </div>
          </ScreenLayerContext.Provider>
        </StoreProvider>
      </div>
    </div>
  );
}

function GalleryCard({
  def,
  size,
  opacity,
  widgetScale,
  config,
}: {
  def: WidgetDefinition;
  size: { w: number; h: number };
  opacity: number;
  widgetScale: number;
  config?: Record<string, unknown>;
}) {
  const meta = widgetMeta(def.id, def.name);
  const transparent = def.transparentPanel?.(config ?? def.defaultConfig) ?? false;
  // Scale the panel down to fit the card width so wide widgets (Standings 620,
  // Relative 400) don't overflow their grid cell and overlap neighbors. Render
  // at native size, then transform:scale — so on-screen proportions are exact.
  const CARD_W = 300;
  const fit = Math.min(CARD_W / size.w, 1);
  return (
    <div
      data-card={def.id}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 14,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 120,
        }}
      >
        <div
          style={{
            width: Math.round(size.w * fit),
            height: Math.round(size.h * fit),
            position: "relative",
            // A faint guide so transparent / full-bleed widgets still show bounds
            // on the contact sheet (single-widget shots omit this).
            outline: transparent ? "1px dashed rgba(255,255,255,0.12)" : "none",
          }}
        >
          <div style={{ transform: `scale(${fit})`, transformOrigin: "top left" }}>
            <GalleryPanel def={def} w={size.w} h={size.h} opacity={opacity} widgetScale={widgetScale} config={config} />
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: theme.colors.text }}>{def.name}</span>
        <span style={{ fontSize: 12, color: theme.colors.textDim2, fontFamily: theme.font.mono }}>
          {def.id} · {size.w}×{size.h}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: theme.colors.textDim, lineHeight: 1.4 }}>{meta.description}</div>
    </div>
  );
}

// Static, document-flow page (not position:fixed) so the contact sheet grows to
// its full height and Playwright's full-page screenshot captures every row. The
// app's global `html,body,#root { overflow:hidden }` is overridden while the
// gallery is mounted (see the effect in WidgetGallery).
function Page({ children, bg }: { children: ReactNode; bg: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: bg,
        backgroundAttachment: "fixed",
        fontFamily: theme.font.family,
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}

export default function WidgetGallery() {
  const params = new URLSearchParams(window.location.search);
  const widgetId = params.get("widget");
  const bg = BACKDROPS[(params.get("bg") as BgKey) ?? "track"] ?? BACKDROPS.track;
  const sizeMode = params.get("size") ?? "default";
  const w = params.get("w") ? Number(params.get("w")) : undefined;
  const h = params.get("h") ? Number(params.get("h")) : undefined;
  const opacity = params.get("opacity") ? Number(params.get("opacity")) : 1;
  const widgetScale = params.get("scale") ? Number(params.get("scale")) : 1;
  let configOverride: Record<string, unknown> | undefined;
  try {
    const raw = params.get("config");
    if (raw) configOverride = JSON.parse(raw);
  } catch {
    configOverride = undefined;
  }

  const [ready, setReady] = useState(false);

  // Feed the preview store(s) with mock telemetry, and expose the registry to the
  // capture script. `ready` flips after a short settle so the first screenshot
  // sees populated data and a stabilized FitContent fit (not an empty frame).
  useEffect(() => {
    // The app pins html/body/#root to overflow:hidden (the overlay must never
    // scroll). The gallery is a dev page that DOES need to scroll/grow so the
    // full contact sheet renders and screenshots. Override while mounted, restore
    // on unmount.
    const targets = [document.documentElement, document.body, document.getElementById("root")];
    const prev = targets.map((el) => el?.style.overflow ?? "");
    targets.forEach((el) => el && (el.style.overflow = "visible"));

    const stop = startPreviewMock();
    (window as unknown as { __WIDGETS__: unknown }).__WIDGETS__ = allWidgetDefs().map((d) => ({
      id: d.id,
      name: d.name,
      defaultSize: d.defaultSize,
      minSize: d.minSize,
      description: widgetMeta(d.id, d.name).description,
      requiredCapabilities: d.requiredCapabilities,
      transparentPanel: !!d.transparentPanel?.(d.defaultConfig),
    }));
    const t = window.setTimeout(() => {
      setReady(true);
      (window as unknown as { __GALLERY_READY__: boolean }).__GALLERY_READY__ = true;
    }, 700);
    return () => {
      window.clearTimeout(t);
      stop();
      targets.forEach((el, i) => el && (el.style.overflow = prev[i]));
    };
  }, []);

  if (widgetId) {
    const def = getWidgetDef(widgetId);
    if (!def) return <Page bg={bg}>{`Unknown widget: ${widgetId}`}</Page>;
    const size = sizeFor(def, sizeMode, w, h);
    return (
      <Page bg={bg}>
        <div
          style={{
            minHeight: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 64,
          }}
        >
          {ready && (
            <GalleryPanel
              def={def}
              w={size.w}
              h={size.h}
              opacity={opacity}
              widgetScale={widgetScale}
              config={configOverride}
            />
          )}
        </div>
      </Page>
    );
  }

  // Contact sheet — every widget.
  return (
    <Page bg={bg}>
      <div style={{ padding: 28 }}>
        <h1 style={{ color: theme.colors.text, fontSize: 22, margin: "0 0 4px" }}>Widget gallery</h1>
        <p style={{ color: theme.colors.textDim, fontSize: 13, margin: "0 0 22px" }}>
          {allWidgetDefs().length} widgets · mock telemetry · backdrop: {params.get("bg") ?? "track"}
        </p>
        {ready && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 18,
              alignItems: "start",
            }}
          >
            {allWidgetDefs().map((def) => (
              <GalleryCard
                key={def.id}
                def={def}
                size={sizeFor(def, sizeMode, w, h)}
                opacity={opacity}
                widgetScale={widgetScale}
                config={configOverride}
              />
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}
