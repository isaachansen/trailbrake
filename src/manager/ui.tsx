// Small shared manager controls. Presentational only — they take value + change.

interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}

export function Toggle({ on, onChange, title }: ToggleProps) {
  return (
    <div
      className={`toggle${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      title={title}
      onClick={() => onChange(!on)}
    />
  );
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

export function Field({ label, children }: FieldProps) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="field-control">{children}</div>
    </div>
  );
}

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}

export function Slider({ value, min, max, step, onChange, format }: SliderProps) {
  return (
    <>
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="field-value">{format ? format(value) : String(value)}</span>
    </>
  );
}
