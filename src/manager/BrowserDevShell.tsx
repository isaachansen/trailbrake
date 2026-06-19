// Browser-only dev shell (`npm run dev`, no Tauri backend). Renders the manager
// plus a live preview of the overlay layer on top, so the whole flow can be
// exercised without the desktop runtime. The overlay layer's visibility/
// interactivity follow the synthetic status that `controls` maintains in the
// browser.

import ManagerApp from "./ManagerApp";
import OverlayApp from "../OverlayApp";
import { useStatus } from "../store/session";

export default function BrowserDevShell() {
  const status = useStatus();
  return (
    <>
      <ManagerApp />
      {status.overlayVisible && (
        <>
          <div
            className="dev-overlay-layer"
            // Always click-through at the layer level; the overlay's own widgets /
            // toolbar / buttons opt back in via their own pointer-events, so the
            // manager UI underneath (e.g. the "Done editing" button) stays clickable
            // even while editing.
            style={{ pointerEvents: "none" }}
          >
            <OverlayApp />
          </div>
          <div className="dev-overlay-frame" />
          <div className="dev-overlay-tag">OVERLAY PREVIEW{status.editing ? " · EDIT MODE" : ""}</div>
        </>
      )}
    </>
  );
}
