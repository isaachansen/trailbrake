import type { CSSProperties } from "react";
import "flag-icons/css/flag-icons.min.css";

const SWATCH: CSSProperties = {
  display: "block",
  width: "1.2em",
  height: "0.82em",
  borderRadius: 2,
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.35)",
  // Neutralize flag-icons' `:before` nbsp + line-height:1em, which otherwise
  // makes the box taller than the painted flag and sits it high in the row.
  lineHeight: 0,
  overflow: "hidden",
  backgroundSize: "cover",
  backgroundPosition: "center",
  flexShrink: 0,
};

const EMPTY: CSSProperties = {
  ...SWATCH,
  background: "rgba(255,255,255,0.12)",
  boxShadow: "inset 0 0 0 1px rgba(0,0,0,.35)",
};

/** Compact nationality swatch for standings / relative rows (flag-icons CSS). */
export function FlagSwatch({ country }: { country: string | null | undefined }) {
  const code = country?.trim().toLowerCase();
  if (!code) return <span style={EMPTY} />;

  return (
    <span
      title={code.toUpperCase()}
      className={`fi fi-${code}`}
      style={SWATCH}
    />
  );
}
