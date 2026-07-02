// Shared widget title — the uppercase "eyebrow" header every panel shows at the
// top. Standardizes the size / spacing / weight / color that used to be
// hand-rolled (and drifted) across widgets. Purely presentational.
//
// `right` is an optional secondary slot (track name, window seconds, a legend, a
// button…) pinned to the far end of the title row via `marginLeft: auto`.

import type { ReactNode } from "react";
import type { Theme } from "../theme/theme";

export function WidgetTitle({ title, theme, right }: { title: string; theme: Theme; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          fontFamily: theme.font.label,
          fontSize: "0.7em",
          letterSpacing: "0.12em",
          fontWeight: 700,
          color: theme.colors.textDim,
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {title}
      </span>
      {right != null && (
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            minWidth: 0,
            flexShrink: 1,
            overflow: "hidden",
          }}
        >
          {right}
        </div>
      )}
    </div>
  );
}
