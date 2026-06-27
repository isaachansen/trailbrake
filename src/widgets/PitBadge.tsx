// Shared "PIT" badge — a compact amber pill shown on a Relative/Standings row
// when the car is on pit road. Amber reads as "out of the racing flow" without
// stealing the eye the way a red would. Sized in em so it scales with the row.

export function PitBadge({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: "1.25em",
        padding: "0 0.4em",
        borderRadius: 4,
        background: color,
        color: "#0a0b0e",
        fontSize: "0.62em",
        fontWeight: 800,
        letterSpacing: "0.08em",
        // letter-spacing adds a trailing gap after the final "T", which shoves the
        // text left of the pill's center; indent by the same amount to re-center.
        textIndent: "0.08em",
        lineHeight: 1,
        flex: "none",
      }}
    >
      PIT
    </span>
  );
}
