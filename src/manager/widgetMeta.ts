// Presentation metadata for the widget catalog (monogram + blurb). Kept here so
// adding a widget doesn't require touching the widget files — unknown ids get a
// sensible fallback derived from the name.

export interface WidgetMeta {
  monogram: string;
  description: string;
}

const META: Record<string, WidgetMeta> = {
  "input-graph": {
    monogram: "IN",
    description: "Live throttle, brake, clutch & steering trace at full frame-rate.",
  },
  "delta-bar": {
    monogram: "Δ",
    description: "Gap to your best / session-best lap as a sliding bar.",
  },
  relative: {
    monogram: "REL",
    description: "Cars immediately around you on track, with time gaps.",
  },
  standings: {
    monogram: "POS",
    description: "Full field order with class, gaps and lap times.",
  },
  proximity: {
    monogram: "RAD",
    description: "Spotter radar showing cars alongside you.",
  },
  "track-map": {
    monogram: "MAP",
    description: "Circuit map with live car positions.",
  },
};

export function widgetMeta(id: string, name: string): WidgetMeta {
  return (
    META[id] ?? {
      monogram: name.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "•",
      description: "Custom widget.",
    }
  );
}
