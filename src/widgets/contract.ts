// The widget contract — the seam that makes "add a widget" a small, consistent
// change (§6). A widget is a presentational component + a definition declaring
// how it should appear in the registry, what data paths it needs, and a config
// schema the settings panel renders generically.

import type { ComponentType } from "react";
import type { Capabilities } from "../store/types";
import type { Theme } from "../theme/theme";

export type DataPath = "fast" | "slow";

/**
 * Session category used for per-field visibility (race / qualy / practice). A
 * coarser grouping than the player's `SessionStateKey`: it's about *what kind of
 * session* the sim reports, derived from its `sessionType` string.
 */
export type SessionType = "race" | "qualy" | "practice";

export const SESSION_TYPES: { key: SessionType; label: string }[] = [
  { key: "race", label: "race" },
  { key: "qualy", label: "qualy" },
  { key: "practice", label: "practice" },
];

/** Classify the sim's `sessionType` string into a coarse race/qualy/practice. */
export function classifySessionType(s: string | null | undefined): SessionType | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("qual")) return "qualy";
  if (t.includes("race")) return "race";
  if (t.includes("practice") || t.includes("warmup") || t.includes("test") || t.includes("lone") || t.includes("open"))
    return "practice";
  return null;
}

/**
 * One entry stored for a `fieldList` config value: whether the field is on, and
 * which session types it shows in. Order in the array is the display order.
 */
export interface InfoFieldConfig {
  key: string;
  on: boolean;
  sessions: SessionType[];
}

/**
 * Merge a saved `fieldList` value with the widget's current catalog: keep saved
 * entries (in their saved order) that still exist in the catalog, append any
 * catalog fields not yet present (off, all sessions), and drop fields the
 * catalog no longer offers. Lets layouts saved before a field existed pick it up.
 */
export function reconcileFieldList(
  value: InfoFieldConfig[] | undefined,
  catalog: { key: string }[]
): InfoFieldConfig[] {
  const keys = new Set(catalog.map((c) => c.key));
  const saved = (value ?? []).filter((e) => keys.has(e.key));
  const seen = new Set(saved.map((e) => e.key));
  const all: SessionType[] = SESSION_TYPES.map((s) => s.key);
  const appended = catalog.filter((c) => !seen.has(c.key)).map((c) => ({ key: c.key, on: false, sessions: [...all] }));
  return [...saved, ...appended].map((e) => ({
    key: e.key,
    on: e.on,
    sessions: Array.isArray(e.sessions) ? e.sessions : [...all],
  }));
}

/** A single configurable option, rendered generically by the settings panel. */
export type ConfigField =
  | { key: string; label: string; type: "boolean" }
  | { key: string; label: string; type: "number"; min: number; max: number; step: number }
  | { key: string; label: string; type: "enum"; options: { value: string; label: string }[] }
  /**
   * An ordered, reorderable list of toggleable info fields, each with per
   * session-type visibility. `fields` is the catalog of selectable entries (in
   * a sensible default order); the stored value is an `InfoFieldConfig[]`.
   */
  | { key: string; label: string; type: "fieldList"; fields: { key: string; label: string }[] };

/** Props every widget receives. Widget-specific options live in `config`. */
export interface BaseWidgetProps<C = Record<string, unknown>> {
  theme: Theme;
  config: C;
  /** What the active sim can provide, so widgets can hide unsupported fields. */
  caps: Capabilities | null;
  /** Box size in px (after resize). Widgets that draw should fill it. */
  size: { w: number; h: number };
}

export interface WidgetDefinition<C = Record<string, unknown>> {
  /** Stable id used in saved layouts and the registry. */
  id: string;
  name: string;
  /** Initial box size when first added. */
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  defaultConfig: C;
  /** Which store paths this widget reads — enforces the fast/slow split. */
  requiredPaths: DataPath[];
  /** Capabilities the widget needs; used to warn when a sim can't feed it. */
  requiredCapabilities: (keyof Capabilities)[];
  /** Declarative options the settings panel turns into controls. */
  configSchema: ConfigField[];
  /**
   * When this returns true for the given config, the host paints no panel chrome
   * (transparent — no fill, border, blur, or shadow) outside edit mode. For
   * widgets that render only a screen-level effect and have no panel of their own.
   */
  transparentPanel?: (config: C) => boolean;
  /**
   * Optional content-driven height (in design px, at scale 1) for a given config.
   * When the widget's config toggles a stacked section on/off, the host resizes
   * the instance by that section's contribution — so removing a section makes the
   * widget *shorter* rather than letting the remaining content stretch to fill the
   * freed space. `defaultSize.h` should equal `contentHeight(defaultConfig)`.
   */
  contentHeight?: (config: C) => number;
  /**
   * Work-in-progress widget: kept in the registry (so it still renders if placed,
   * and shows up for development in `npm run dev` / `tauri dev`) but hidden from
   * the add-widget catalogs in production/release builds, so users can't add it
   * until it's ready. See `allWidgetDefs`.
   */
  draft?: boolean;
  Component: ComponentType<BaseWidgetProps<C>>;
}
