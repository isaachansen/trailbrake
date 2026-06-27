// A DOM node that "screen effect" widgets (e.g. the Spotter edge glow) portal
// into, decoupling the effect from the widget's own panel box — which sits inside
// a backdrop-filtered ancestor and so can't escape to the viewport on its own.
//
// On the live overlay the node fills the viewport; in the manager preview it's the
// preview card, so the same effect demos itself inside the card. `preview` lets an
// effect force a static demo (the gallery has no live "car alongside" to react to).

import { createContext, useContext } from "react";

export interface ScreenLayer {
  /** Portal target, or null until the layer element has mounted. */
  el: HTMLElement | null;
  /** True in the manager preview/gallery — render a static demo, not live data. */
  preview: boolean;
  /**
   * True when the layer spans a full "screen" region (the live viewport, or the
   * manager preview's screen-sized stage) so screen-edge effects pin to its
   * edges and fade inward. False when the layer is only the widget's own panel
   * box (the isolated gallery), where an edge effect instead flanks the panel.
   */
  fullScreen: boolean;
}

export const ScreenLayerContext = createContext<ScreenLayer>({ el: null, preview: false, fullScreen: false });

export function useScreenLayer(): ScreenLayer {
  return useContext(ScreenLayerContext);
}
