// iRacing track IDs where a single closed-loop centerline cannot represent the
// layout (figure-8, dual-path, non-continuous). Clean-room list — concepts only,
// no third-party code copied.

/** @type {{ id: number; name: string; reason: string }[]} */
export const BROKEN_TRACKS = [
  { id: 175, name: "Suzuka", reason: "non-continuous layout" },
  { id: 176, name: "Suzuka", reason: "non-continuous layout" },
  { id: 207, name: "Oran Park", reason: "non-continuous layout" },
  { id: 209, name: "Oran Park", reason: "non-continuous layout" },
  { id: 211, name: "Oran Park", reason: "non-continuous layout" },
  { id: 193, name: "Daytona Bike", reason: "no reliable position mapping" },
  { id: 217, name: "Irwindale Figure 8", reason: "figure-8 layout" },
  { id: 388, name: "Irwindale Figure 8", reason: "figure-8 layout" },
  { id: 437, name: "LA Coliseum", reason: "dual-path layout" },
  { id: 452, name: "Wheatland Lucasoil", reason: "dual-path layout" },
  { id: 506, name: "Slinger", reason: "figure-8 layout" },
];

export const BROKEN_TRACK_IDS = new Set(BROKEN_TRACKS.map((t) => t.id));

/** @param {number} trackId */
export function brokenTrackReason(trackId) {
  const t = BROKEN_TRACKS.find((x) => x.id === trackId);
  if (!t) return null;
  return `Track map unavailable (${t.reason})`;
}
