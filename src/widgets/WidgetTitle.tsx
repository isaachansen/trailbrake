// Optional top-row slot for secondary chrome (status, track name, legend, action
// button) pinned to the trailing edge. Widget name eyebrows were removed — the
// host already labels widgets in edit mode.

import type { ReactNode } from "react";
import type { Theme } from "../theme/theme";

export function WidgetTitle({ theme: _theme, right }: { title?: string; theme: Theme; right?: ReactNode }) {
  if (right == null) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", minWidth: 0, overflow: "hidden" }}>{right}</div>
    </div>
  );
}
