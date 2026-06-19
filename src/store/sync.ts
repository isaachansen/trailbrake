// Cross-window sync. The manager and overlay are separate webviews with separate
// JS stores; this keeps their layout + selection + display units in lockstep so a
// change in the manager updates the on-screen overlay instantly (and vice-versa).
//
// Each window tags its broadcasts with a unique nonce and ignores its own echoes,
// so applying a remote change never re-broadcasts (no feedback loop). In a plain
// browser there's a single context, so this is a no-op.

import { layoutStore } from "./layout";
import { settingsStore } from "./appSettings";
import { isTauri } from "./transport";
import type { UnitSystem } from "../widgets/format";

const NONCE = Math.random().toString(36).slice(2);
const EVT_LAYOUT = "overlay://layout-sync";
const EVT_SELECT = "overlay://select-sync";
const EVT_UNITS = "overlay://units-sync";

export async function initSync(): Promise<() => void> {
  if (!isTauri()) return () => {};

  const { listen, emit } = await import("@tauri-apps/api/event");

  layoutStore.setBroadcaster((blob) => void emit(EVT_LAYOUT, { nonce: NONCE, blob }));
  layoutStore.setSelectionBroadcaster((id) => void emit(EVT_SELECT, { nonce: NONCE, id }));
  settingsStore.setUnitsBroadcaster((u) => void emit(EVT_UNITS, { nonce: NONCE, u }));

  // Start this window in sync with the persisted units (the overlay window doesn't
  // run settingsStore.init(), so it would otherwise stay on the default).
  await settingsStore.loadUnits();

  const unLayout = await listen<{ nonce: string; blob: string }>(EVT_LAYOUT, (e) => {
    if (e.payload.nonce === NONCE) return;
    layoutStore.applyExternal(e.payload.blob);
  });
  const unSelect = await listen<{ nonce: string; id: string | null }>(EVT_SELECT, (e) => {
    if (e.payload.nonce === NONCE) return;
    layoutStore.applyExternalSelection(e.payload.id);
  });
  const unUnits = await listen<{ nonce: string; u: UnitSystem }>(EVT_UNITS, (e) => {
    if (e.payload.nonce === NONCE) return;
    settingsStore.applyUnits(e.payload.u);
  });

  return () => {
    layoutStore.setBroadcaster(null);
    layoutStore.setSelectionBroadcaster(null);
    settingsStore.setUnitsBroadcaster(null);
    unLayout();
    unSelect();
    unUnits();
  };
}
