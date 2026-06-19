// React bindings for the slow path. The fast path is intentionally NOT exposed
// as a hook — fast widgets read the store directly in a rAF loop (see InputGraph).
//
// These resolve the store from context (`useStoreInstance`), so a widget rendered
// inside a `StoreProvider` (e.g. the manager's previews) reads that store; with
// no provider it's the global singleton.

import { useSyncExternalStore } from "react";
import { useStoreInstance } from "./storeContext";
import type { Capabilities, SlowSample } from "./types";

export function useSlow(): SlowSample | null {
  const store = useStoreInstance();
  return useSyncExternalStore(store.subscribeSlow, store.getSlow);
}

export function useCaps(): Capabilities | null {
  const store = useStoreInstance();
  return useSyncExternalStore(store.subscribeSlow, store.getCaps);
}
