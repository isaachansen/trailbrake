// Shared position chip used by Standings and Relative — full row height,
// square corners, recessed fill (same container for live + provisional).

import { defaultTheme } from "../theme/theme";
import type { Theme } from "../theme/theme";

const MONO = defaultTheme.font.mono;

const TITLE_PROVISIONAL =
  "Provisional — grid, qualify, or car-number order (no live session position yet)";

export function PosChip({
  pos,
  provisional,
  isPlayer,
  t,
  /** Row slot height in em — chip stretches to match. */
  rowH,
}: {
  pos: number;
  provisional: boolean;
  isPlayer: boolean;
  t: Theme["colors"];
  rowH: number;
}) {
  return (
    <span
      title={provisional ? TITLE_PROVISIONAL : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "stretch",
        minWidth: "2.6em",
        width: "100%",
        height: `${rowH}em`,
        padding: "0 0.4em",
        boxSizing: "border-box",
        borderRadius: 0,
        background: "rgba(0,0,0,0.28)",
        fontFamily: MONO,
        fontVariantNumeric: "tabular-nums",
        fontWeight: isPlayer ? 800 : 700,
        fontSize: "1em",
        lineHeight: 1,
        color: isPlayer ? "#fff" : provisional ? t.textDim : t.text,
      }}
    >
      {pos}
    </span>
  );
}
