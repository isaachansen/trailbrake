// Buy Me a Coffee support button. Uses BMC's official button-image API (rather
// than their runtime widget <script>) so it's a single self-contained link:
// reliable and degrades gracefully offline.
//
// A plain <a target="_blank"> does NOT reach the system browser from a Tauri
// webview — it just navigates (or no-ops) inside the app. So in Tauri we open
// it explicitly via the opener plugin; in plain-browser dev mode (no Tauri
// runtime) `window.open` already does the right thing.

import type { MouseEvent } from "react";
import { isTauri } from "../store/transport";

const BMC_URL = "https://www.buymeacoffee.com/trailbrake";
const BMC_IMG =
  "https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=trailbrake" +
  "&button_colour=5F7FFF&font_colour=ffffff&font_family=Cookie&outline_colour=000000&coffee_colour=FFDD00";

async function openBmc(e: MouseEvent) {
  e.preventDefault();
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(BMC_URL);
  } else {
    window.open(BMC_URL, "_blank", "noopener");
  }
}

export function BuyMeACoffee() {
  return (
    <a
      href={BMC_URL}
      onClick={openBmc}
      title="Support Trailbrake on Buy Me a Coffee"
      style={{ cursor: "pointer" }}
    >
      <img src={BMC_IMG} alt="Buy me a coffee" style={{ height: 44, display: "block", borderRadius: 10 }} />
    </a>
  );
}
