// Shared license / safety-rating badge used by Standings and Relative.
//
// iRacing-style split pill: the class letter sits on a solid license-color
// block, the SR number on a dark slab beside it, the whole thing framed in the
// license color. Fixed width so every badge is the same length and the column
// stays tidy; the row wraps it in a full-height flex so it centers vertically.

import { LIC } from "./raceColors";
import { defaultTheme } from "../theme/theme";

const FAMILY = defaultTheme.font.family;
const MONO = defaultTheme.font.mono;

export function LicenseBadge({ letter, sr }: { letter: string; sr: string }) {
  const color = LIC[letter] ?? "#9aa0ab";
  // Two decimals to match the iRacing license chip ("4.50", not "4.5"); leave
  // non-numeric values (rare) untouched.
  const n = Number(sr);
  const srText = sr ? (Number.isFinite(n) ? n.toFixed(2) : sr) : "";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        width: "4em",
        height: "1.66em",
        verticalAlign: "middle",
        boxSizing: "border-box",
        borderRadius: 5,
        border: `0.11em solid ${color}`,
        overflow: "hidden",
        whiteSpace: "nowrap",
        lineHeight: 1,
      }}
    >
      {/* Class letter on the solid license color. */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.4em",
          flex: "none",
          background: color,
          color: "#0a0b0e",
          fontFamily: FAMILY,
          fontWeight: 800,
          fontSize: "0.96em",
        }}
      >
        {letter}
      </span>
      {/* SR number on a dark slab, framed by the color border. */}
      {srText && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            background: "#16181f",
            color: "#fff",
            fontFamily: MONO,
            fontWeight: 700,
            fontSize: "0.82em",
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.01em",
          }}
        >
          {srText}
        </span>
      )}
    </span>
  );
}
