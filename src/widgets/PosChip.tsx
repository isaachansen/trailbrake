// Shared position chip — full row height, square, recessed fill from Theme.list.

import type { Theme } from "../theme/theme";

const TITLE_PROVISIONAL =
  "Provisional — grid, qualify, or car-number order (no live session position yet)";

export function PosChip({
  pos,
  provisional,
  isPlayer,
  theme,
  /** Row slot height in em — chip stretches to match. */
  rowH,
}: {
  pos: number;
  provisional: boolean;
  isPlayer: boolean;
  theme: Theme;
  rowH: number;
}) {
  const t = theme.colors;
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
        background: theme.list.posChipBg,
        fontFamily: theme.font.mono,
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
