// The control window. Boots the shared stores (telemetry transport, layout,
// settings, status) and hosts the navigable pages. The actual overlay rendering
// happens in the separate overlay window; this app drives it via the layout
// store (synced cross-window) and the `controls` command surface.

import { useEffect, useState } from "react";
import "./manager.css";
import { initTransport } from "../store/transport";
import { layoutStore } from "../store/layout";
import { settingsStore, useSettings } from "../store/appSettings";
import { controls } from "../store/controls";
import { accentVars } from "./accent";
import { NavRail, TopBar, type Page } from "./shell";
import { WidgetsPage } from "./pages/WidgetsPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function ManagerApp() {
  const [page, setPage] = useState<Page>("widgets");
  const settings = useSettings();

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    initTransport().then((c) => {
      if (cancelled) c();
      else cleanup = c;
    });
    void layoutStore.init();
    void settingsStore.init();
    void controls.fetchStatus();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className="mgr" style={accentVars(settings.accentColor)}>
      <NavRail page={page} onNavigate={setPage} />
      <div className="mgr-main">
        <TopBar page={page} />
        <main className="mgr-content">
          {page === "widgets" && <WidgetsPage />}
          {page === "profiles" && <ProfilesPage />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
