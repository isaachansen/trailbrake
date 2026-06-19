// Shared tyre-compound badge. Styled like a tyre: a colored disc (the compound)
// inside a black ring (the rubber). Rendered as ONE circle — colored fill + a
// thick black border for the ring — so the disc is concentric by construction
// and can't drift from sub-pixel rounding of two separate boxes.
//
// Color encodes the compound when the sim gives it (Soft/Medium/Hard/Wet); when
// it only reports dry-vs-wet, dry is gray and wet is the same blue.

import { TYRE } from "./raceColors";

/** Resolve a compound code or generic dry/wet word to its swatch color. */
function tyreColor(c: string): string {
  const k = c.trim().toUpperCase();
  if (k === "DRY") return TYRE.D;
  if (k === "WET") return TYRE.W;
  return TYRE[k] ?? TYRE.D; // unknown → treat as generic dry (gray)
}

export function TyreBadge({ compound, size = "1.45em" }: { compound: string | null | undefined; size?: string }) {
  if (!compound) return null;
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        boxSizing: "border-box",
        borderRadius: "50%",
        background: tyreColor(compound),
        border: `calc(${size} * 0.15) solid #0a0b0e`,
        verticalAlign: "middle",
        flex: "none",
      }}
    />
  );
}
