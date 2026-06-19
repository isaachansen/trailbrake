// The player's session state, used for per-widget visibility ("Show overlay
// when …"), mirroring iOverlay's In car / Out of car / Spotting / In garage.
//
// Derived from the normalized telemetry: `onTrack` (driving) and `inGarage`.
// "Spotting" needs a spectator/camera signal the connector doesn't surface yet,
// so it isn't actively detected — the toggle exists for parity and future use.

import type { SlowSample } from "./types";

export type SessionStateKey = "inCar" | "outOfCar" | "spotting" | "inGarage";

export const SESSION_STATES: { key: SessionStateKey; label: string }[] = [
  { key: "inCar", label: "In car" },
  { key: "outOfCar", label: "Out of car" },
  { key: "spotting", label: "Spotting" },
  { key: "inGarage", label: "In garage" },
];

export const ALL_SESSION_STATES: SessionStateKey[] = ["inCar", "outOfCar", "spotting", "inGarage"];

export function sessionStateLabel(key: SessionStateKey): string {
  return SESSION_STATES.find((s) => s.key === key)?.label ?? key;
}

/** Current player session state, or null when the sim doesn't report it. */
export function deriveSessionState(slow: SlowSample | null): SessionStateKey | null {
  if (!slow) return null;
  if (slow.onTrack == null && slow.inGarage == null) return null;
  if (slow.onTrack) return "inCar";
  if (slow.inGarage) return "inGarage";
  // No reliable spectator/camera signal yet → treat "not driving, not garage" as
  // out of car. (Spotting detection is a future connector addition.)
  return "outOfCar";
}
