// Lets a subtree read from a specific telemetry store instead of the global
// singleton. The overlay renders widgets with no provider, so they resolve to
// the global `store` (fed by the real source). The manager wraps its live widget
// previews in a provider backed by a separate, mock-fed store — so previews
// always show believable data without disturbing the real telemetry the manager
// uses for car detection / capabilities.

import { createContext, useContext, type ReactNode } from "react";
import { store as globalStore, TelemetryStore } from "./store";

const StoreContext = createContext<TelemetryStore>(globalStore);

export function StoreProvider({ store, children }: { store: TelemetryStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The telemetry store for the current subtree (global unless a provider overrides). */
export function useStoreInstance(): TelemetryStore {
  return useContext(StoreContext);
}
