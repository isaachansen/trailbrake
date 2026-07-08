// Open a URL in the system browser. Tauri webviews don't hand off plain
// <a target="_blank"> links, so we use the opener plugin there; browser dev
// falls back to window.open.

import type { MouseEvent } from "react";
import { isTauri } from "../store/transport";

export async function openExternalUrl(url: string, e?: MouseEvent) {
  e?.preventDefault();
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
