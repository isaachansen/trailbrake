// A reusable color control for the manager: preset swatches plus a custom color
// wheel — the same UI the Settings accent picker uses. Drives any hex value via
// `onChange`. (Relies on the `.accent-*` styles + ColorWheel, so it's manager-only.)

import { useRef, useState } from "react";
import { ColorWheel } from "./ColorWheel";

export function ColorField({
  value,
  presets,
  onChange,
}: {
  value: string;
  presets: { hex: string; name: string }[];
  onChange: (hex: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const v = (value || "").toLowerCase();
  const isCustom = !presets.some((p) => p.hex.toLowerCase() === v);

  return (
    <div className="accent-swatches">
      {presets.map((p) => (
        <button
          key={p.hex}
          type="button"
          title={p.name}
          aria-label={p.name}
          className={`accent-swatch${v === p.hex.toLowerCase() ? " on" : ""}`}
          style={{ background: p.hex }}
          onClick={() => onChange(p.hex)}
        />
      ))}
      <button
        ref={triggerRef}
        type="button"
        data-accent-trigger
        title="Custom color"
        aria-label="Custom color"
        className={`accent-swatch accent-custom${isCustom ? " on" : ""}${open ? " open" : ""}`}
        style={
          isCustom
            ? {
                background: value,
                borderColor: "transparent",
                boxShadow: `0 0 0 2px rgba(0, 0, 0, 0.45), 0 0 0 4px ${value}`,
              }
            : undefined
        }
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <ColorWheel
          value={value}
          onChange={onChange}
          onClose={() => setOpen(false)}
          anchorEl={triggerRef.current}
        />
      )}
    </div>
  );
}
