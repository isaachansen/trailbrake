// Shared "PIT" badge — a compact amber pill shown inline next to a driver name
// on Relative/Standings when the car is on pit road. Amber reads as "out of the
// racing flow" without stealing the eye the way a red would.
//
// Outer box sized in the row's em so the name cell can flex-center it; label
// text nested smaller. Kept a hair under the license chip so it reads as a
// name annotation.

import { defaultTheme } from "../theme/theme";

const LABEL = defaultTheme.font.label;

export function PitBadge({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: "1.1em",
        padding: "0 0.4em",
        boxSizing: "border-box",
        borderRadius: 4,
        background: color,
        flex: "none",
        lineHeight: 1,
      }}
    >
      <span
        style={{
          display: "block",
          fontFamily: LABEL,
          fontSize: "0.72em",
          fontWeight: 800,
          letterSpacing: "0.07em",
          // letter-spacing adds a trailing gap after the final "T"; indent by the
          // same amount so the word sits centered in the pill.
          textIndent: "0.07em",
          color: "#0a0b0e",
          lineHeight: 1,
        }}
      >
        PIT
      </span>
    </span>
  );
}
