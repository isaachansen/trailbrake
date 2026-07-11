import { flagEmoji, flagOf, hasFlagGradient } from "./raceColors";

/** Compact nationality swatch for standings / relative rows. */
export function FlagSwatch({ country }: { country: string | null | undefined }) {
  const code = country?.toUpperCase() ?? null;
  if (code && hasFlagGradient(code)) {
    return (
      <span
        title={code}
        style={{
          display: "inline-block",
          width: "1.2em",
          height: "0.82em",
          borderRadius: 2,
          background: flagOf(code),
          boxShadow: "inset 0 0 0 1px rgba(0,0,0,.35)",
        }}
      />
    );
  }
  const emoji = flagEmoji(code);
  if (emoji) {
    return (
      <span
        title={code ?? undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.2em",
          height: "0.82em",
          fontSize: "0.95em",
          lineHeight: 1,
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        {emoji}
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        width: "1.2em",
        height: "0.82em",
        borderRadius: 2,
        background: "rgba(255,255,255,0.12)",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,.35)",
      }}
    />
  );
}
