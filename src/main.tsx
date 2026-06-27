import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { isTauri } from "./store/transport";

// One bundle serves two Tauri windows. We pick the React root from the window
// label: "overlay" → the transparent widget surface, anything else → the
// manager control UI. In a plain browser there's a single window, so we render a
// dev shell that hosts the manager with the overlay as a preview layer.
async function boot() {
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

  // Dev/visual-testing route: `?gallery` renders every widget in isolation with
  // mock data, for screenshot capture and UI review (see scripts/shoot-widgets.mjs).
  if (!isTauri() && new URLSearchParams(window.location.search).has("gallery")) {
    const { default: WidgetGallery } = await import("./gallery/WidgetGallery");
    root.render(
      <React.StrictMode>
        <WidgetGallery />
      </React.StrictMode>
    );
    return;
  }

  let label = "manager";
  if (isTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    label = getCurrentWindow().label;
  }

  if (isTauri() && label === "overlay") {
    const { default: OverlayApp } = await import("./OverlayApp");
    root.render(
      <React.StrictMode>
        <OverlayApp />
      </React.StrictMode>
    );
    return;
  }

  if (isTauri()) {
    const { default: ManagerApp } = await import("./manager/ManagerApp");
    root.render(
      <React.StrictMode>
        <ManagerApp />
      </React.StrictMode>
    );
    return;
  }

  // Browser dev: manager + a live preview of the overlay layer.
  const { default: BrowserDevShell } = await import("./manager/BrowserDevShell");
  root.render(
    <React.StrictMode>
      <BrowserDevShell />
    </React.StrictMode>
  );
}

void boot();
