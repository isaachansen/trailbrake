// A dedicated telemetry store for the manager's widget previews, fed by the
// browser mock. Kept separate from the global store so previews always show
// believable data regardless of the real source — and without overwriting the
// real car/session data the manager uses elsewhere.

import { TelemetryStore } from "../store/store";
import { startBrowserMock } from "../store/mockSource";

export const previewStore = new TelemetryStore();

/** Start feeding the preview store with mock telemetry. Returns a stop function. */
export function startPreviewMock(): () => void {
  return startBrowserMock(previewStore);
}
