// Fast-path widgets (Dash Cluster, Tachometer) only need the live car's *name*
// out of the slow sample — to resolve its shift-light profile — not every other
// slow field. `useSlow()` would re-render them on every slow tick (gaps, weather,
// session state, ...) even though none of that affects what they draw. This
// subscribes to the same store event but only calls setState when the car name
// itself changes, so the component re-renders solely on a car change (which is
// rare — pit a different car, or connect to a new session).

import { useEffect, useRef, useState } from "react";
import { useStoreInstance } from "../store/storeContext";

export function useCarName(): string | null {
  const store = useStoreInstance();
  const [name, setName] = useState<string | null>(() => store.getSlow()?.carName ?? null);
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    return store.subscribeSlow(() => {
      const n = store.getSlow()?.carName ?? null;
      if (n !== nameRef.current) setName(n);
    });
  }, [store]);

  return name;
}
