// Identifies whether the current render tree is the actual transparent
// "overlay" window compositing live over the game, as opposed to the manager
// window, the widget gallery, or the browser dev-shell's in-page overlay
// preview (`BrowserDevShell.tsx`) — none of which sit over a real sim.
//
// This matters for `backdrop-filter: blur()`: it's cheap and looks good when
// there's real in-app content behind the panel to blur (manager, gallery,
// previews). On the live overlay it composites over a *different* HWND (the
// game) that `backdrop-filter` cannot sample, so it produces little-to-no
// visible blur there while still forcing a full-frame GPU blur pass (and its
// own compositor layer) per panel, every frame — a real GPU tax on what's
// often already a GPU-bound sim (see the LMU perf investigation).
//
// Implementation note: `main.tsx` only ever mounts `OverlayApp` in one of two
// places — (a) inside Tauri, when the current window's label is "overlay",
// or (b) the browser dev-shell preview, where `isTauri()` is false. So
// `isTauri()` alone is already an exact proxy for "is the live overlay
// window" for everything under `OverlayApp`. If `OverlayApp` (or
// `WidgetHost`) is ever mounted from a third place inside Tauri, revisit
// this.
import { isTauri } from "./transport";

export function isLiveOverlayWindow(): boolean {
  return isTauri();
}
