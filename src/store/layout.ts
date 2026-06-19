// Layout store: the set of placed widget instances, organized into named
// profiles, persisted to disk. This is the customizability backbone (§6):
// position/size/scale/opacity/visibility/lock + per-widget config all live here
// and survive restarts. Per-car auto-switching of profiles comes later.

import { useSyncExternalStore } from "react";
import { getWidgetDef } from "../widgets/registry";
import { loadConfig, saveConfig } from "./persistence";
import { ALL_SESSION_STATES, type SessionStateKey } from "./sessionState";

export interface WidgetInstance {
  instanceId: string;
  /** Widget definition id (registry key). */
  type: string;
  position: { x: number; y: number };
  size: { w: number; h: number };
  /** Uniform font/density multiplier applied on top of `size`. */
  scale: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  /** Session states this widget shows in (In car / Out of car / Spotting / In garage). */
  showIn: SessionStateKey[];
  /** Inherit the global default instead of this instance's own value. */
  useGeneralOpacity: boolean;
  useGeneralScale: boolean;
  useGeneralShowIn: boolean;
  config: Record<string, unknown>;
}

/** Global overlay defaults; widgets inherit these via their `useGeneral*` flags. */
export interface OverlayDefaults {
  opacity: number;
  scale: number;
  showIn: SessionStateKey[];
}

export const DEFAULT_DEFAULTS: OverlayDefaults = {
  // Near-solid by default so panels are readable out of the box; opacity now maps
  // to the panel background alpha (not element opacity), so this never dims text.
  opacity: 1,
  scale: 1,
  showIn: [...ALL_SESSION_STATES],
};

export interface Layout {
  name: string;
  widgets: WidgetInstance[];
}

interface ConfigBlob {
  version: number;
  active: string;
  profiles: Record<string, Layout>;
  /** Car-model name → profile name, for per-car auto-switching. */
  carProfiles?: Record<string, string>;
  /** Global overlay defaults (size/opacity/visibility) inherited via useGeneral. */
  defaults?: Partial<OverlayDefaults>;
  /** Full-height red screen-edge glow when a car is alongside (spotter). */
  spotterEdges?: boolean;
}

interface LayoutState {
  active: string;
  profiles: Record<string, Layout>;
  carProfiles: Record<string, string>;
  defaults: OverlayDefaults;
  spotterEdges: boolean;
  selectedId: string | null;
  loaded: boolean;
}

function normalizeDefaults(d: Partial<OverlayDefaults> | undefined): OverlayDefaults {
  return {
    opacity: d?.opacity ?? DEFAULT_DEFAULTS.opacity,
    scale: d?.scale ?? DEFAULT_DEFAULTS.scale,
    showIn: Array.isArray(d?.showIn) ? (d!.showIn as SessionStateKey[]) : [...DEFAULT_DEFAULTS.showIn],
  };
}

/** Migrate a widget's `showIn` from the legacy 3-state string to the state array. */
function migrateShowIn(v: unknown): SessionStateKey[] {
  if (Array.isArray(v)) {
    return v.filter((s): s is SessionStateKey => ALL_SESSION_STATES.includes(s as SessionStateKey));
  }
  if (v === "track") return ["inCar"];
  if (v === "garage") return ["inGarage", "outOfCar", "spotting"];
  return [...ALL_SESSION_STATES]; // "both" / undefined → all states
}

const CONFIG_VERSION = 1;

function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? c.randomUUID() : "w" + Math.random().toString(36).slice(2, 10);
}

function makeInstance(type: string, index: number): WidgetInstance | null {
  const def = getWidgetDef(type);
  if (!def) return null;
  return {
    instanceId: uid(),
    type,
    position: { x: 40 + index * 24, y: 40 + index * 24 },
    size: { ...def.defaultSize },
    scale: 1,
    opacity: 0.92,
    visible: true,
    locked: false,
    showIn: [...ALL_SESSION_STATES],
    useGeneralOpacity: true,
    useGeneralScale: true,
    useGeneralShowIn: true,
    config: structuredClone(def.defaultConfig),
  };
}

/** The full v2 composite layout — all widgets placed (≈1080p), mirroring the
 * Claude Design handoff so a fresh install looks like the reference. */
function defaultLayout(): Layout {
  const place = (type: string, x: number, y: number): WidgetInstance | null => {
    const inst = makeInstance(type, 0);
    if (inst) inst.position = { x, y };
    return inst;
  };
  const widgets = [
    place("standings", 28, 26),
    place("relative", 28, 700),
    place("input-graph", 684, 26),
    place("delta-bar", 684, 306),
    place("track-map", 1536, 26),
    place("fuel-session", 1536, 306),
    place("radar", 486, 560),
    place("dash-cluster", 660, 898),
  ].filter((w): w is WidgetInstance => w !== null);
  return { name: "Default", widgets };
}

let state: LayoutState = {
  active: "Default",
  profiles: { Default: defaultLayout() },
  carProfiles: {},
  defaults: { ...DEFAULT_DEFAULTS },
  spotterEdges: true,
  selectedId: null,
  loaded: false,
};

/** Last car-model name seen, so auto-switch only fires on change. */
let lastCar: string | null = null;

const listeners = new Set<() => void>();
function emit() {
  state = { ...state };
  listeners.forEach((l) => l());
}

// --- cross-window broadcast hooks (set by the sync module in Tauri) ---
let broadcaster: ((blob: string) => void) | null = null;
let selectionBroadcaster: ((id: string | null) => void) | null = null;

function currentBlob(): ConfigBlob {
  return {
    version: CONFIG_VERSION,
    active: state.active,
    profiles: state.profiles,
    carProfiles: state.carProfiles,
    defaults: state.defaults,
    spotterEdges: state.spotterEdges,
  };
}

// --- persistence (debounced) + broadcast (faster, so other windows feel live) ---
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveConfig(JSON.stringify(currentBlob())), 400);
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => broadcaster?.(JSON.stringify(currentBlob())), 120);
}

function current(): Layout {
  return state.profiles[state.active] ?? defaultLayout();
}

function replaceCurrent(next: Layout) {
  state = { ...state, profiles: { ...state.profiles, [state.active]: next } };
  emit();
  schedulePersist();
}

/// Reconcile a loaded layout with the current code: merge each widget's current
/// default config into the saved one (so options added since the layout was
/// saved get sensible defaults instead of `undefined`), and drop widget types
/// that no longer exist.
function normalizeProfiles(profiles: Record<string, Layout>): Record<string, Layout> {
  const out: Record<string, Layout> = {};
  for (const [name, layout] of Object.entries(profiles)) {
    const widgets = (layout?.widgets ?? [])
      .map((w) => {
        const def = getWidgetDef(w.type);
        if (!def) return null;
        return {
          ...w,
          showIn: migrateShowIn((w as { showIn?: unknown }).showIn),
          useGeneralOpacity: w.useGeneralOpacity ?? true,
          useGeneralScale: w.useGeneralScale ?? true,
          useGeneralShowIn: w.useGeneralShowIn ?? true,
          config: { ...structuredClone(def.defaultConfig), ...(w.config ?? {}) },
        };
      })
      .filter((w): w is WidgetInstance => w !== null);
    out[name] = { name: layout?.name ?? name, widgets };
  }
  return out;
}

export const layoutStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  snapshot(): LayoutState {
    return state;
  },

  /** Wire up cross-window broadcasting (set by the sync module, or null to clear). */
  setBroadcaster(fn: ((blob: string) => void) | null) {
    broadcaster = fn;
  },
  setSelectionBroadcaster(fn: ((id: string | null) => void) | null) {
    selectionBroadcaster = fn;
  },

  /** Apply a layout blob received from another window (no persist, no re-broadcast). */
  applyExternal(raw: string) {
    try {
      const blob = JSON.parse(raw) as ConfigBlob;
      if (!blob.profiles || !Object.keys(blob.profiles).length) return;
      const active = blob.profiles[blob.active] ? blob.active : Object.keys(blob.profiles)[0];
      // Keep our own selection if it still exists in the incoming active profile.
      const stillThere = blob.profiles[active]?.widgets?.some((w) => w.instanceId === state.selectedId);
      state = {
        active,
        profiles: normalizeProfiles(blob.profiles),
        carProfiles: blob.carProfiles ?? {},
        defaults: normalizeDefaults(blob.defaults),
        spotterEdges: blob.spotterEdges ?? true,
        selectedId: stillThere ? state.selectedId : null,
        loaded: true,
      };
      emit();
    } catch {
      /* ignore malformed sync */
    }
  },

  /** Apply a selection change received from another window. */
  applyExternalSelection(id: string | null) {
    state = { ...state, selectedId: id };
    emit();
  },

  /** Global overlay defaults (inherited by widgets via their useGeneral* flags). */
  getDefaults(): OverlayDefaults {
    return state.defaults;
  },
  setDefault(partial: Partial<OverlayDefaults>) {
    state = { ...state, defaults: { ...state.defaults, ...partial } };
    emit();
    schedulePersist();
  },
  /** Toggle the full-height red screen-edge spotter glow. */
  setSpotterEdges(on: boolean) {
    state = { ...state, spotterEdges: on };
    emit();
    schedulePersist();
  },
  /** Resolve a widget's effective opacity/scale/showIn (own value or the global default). */
  getEffective(inst: WidgetInstance): { opacity: number; scale: number; showIn: SessionStateKey[] } {
    const d = state.defaults;
    return {
      opacity: inst.useGeneralOpacity ? d.opacity : inst.opacity,
      scale: inst.useGeneralScale ? d.scale : inst.scale,
      showIn: inst.useGeneralShowIn ? d.showIn : inst.showIn,
    };
  },

  async init() {
    const raw = await loadConfig();
    if (raw) {
      try {
        const blob = JSON.parse(raw) as ConfigBlob;
        if (blob.profiles && Object.keys(blob.profiles).length) {
          const active = blob.profiles[blob.active] ? blob.active : Object.keys(blob.profiles)[0];
          state = {
            active,
            profiles: normalizeProfiles(blob.profiles),
            carProfiles: blob.carProfiles ?? {},
            defaults: normalizeDefaults(blob.defaults),
            spotterEdges: blob.spotterEdges ?? true,
            selectedId: null,
            loaded: true,
          };
          emit();
          return;
        }
      } catch {
        /* fall through to default */
      }
    }
    state = { ...state, loaded: true };
    emit();
    schedulePersist();
  },

  current,
  listProfiles(): string[] {
    return Object.keys(state.profiles);
  },

  /** Reset the active profile to the built-in default layout. */
  resetProfile() {
    const fresh = { ...defaultLayout(), name: state.active };
    state = { ...state, profiles: { ...state.profiles, [state.active]: fresh }, selectedId: null };
    emit();
    schedulePersist();
  },

  addWidget(type: string) {
    const layout = current();
    const inst = makeInstance(type, layout.widgets.length);
    if (!inst) return;
    replaceCurrentWithSelection({ ...layout, widgets: [...layout.widgets, inst] }, inst.instanceId);
  },

  removeWidget(id: string) {
    const layout = current();
    replaceCurrentWithSelection(
      { ...layout, widgets: layout.widgets.filter((w) => w.instanceId !== id) },
      state.selectedId === id ? null : state.selectedId
    );
  },

  updateInstance(id: string, partial: Partial<WidgetInstance>) {
    const layout = current();
    replaceCurrent({
      ...layout,
      widgets: layout.widgets.map((w) => (w.instanceId === id ? { ...w, ...partial } : w)),
    });
  },

  updateConfig(id: string, partial: Record<string, unknown>) {
    const layout = current();
    replaceCurrent({
      ...layout,
      widgets: layout.widgets.map((w) =>
        w.instanceId === id ? { ...w, config: { ...w.config, ...partial } } : w
      ),
    });
  },

  resetConfig(id: string) {
    const layout = current();
    replaceCurrent({
      ...layout,
      widgets: layout.widgets.map((w) => {
        if (w.instanceId !== id) return w;
        const def = getWidgetDef(w.type);
        return def ? { ...w, config: structuredClone(def.defaultConfig) } : w;
      }),
    });
  },

  select(id: string | null) {
    state = { ...state, selectedId: id };
    emit();
    selectionBroadcaster?.(id);
  },

  setActive(name: string) {
    if (!state.profiles[name]) return;
    state = { ...state, active: name, selectedId: null };
    emit();
    schedulePersist();
  },

  newProfile(name: string) {
    const trimmed = name.trim();
    if (!trimmed || state.profiles[trimmed]) return;
    state = {
      ...state,
      profiles: { ...state.profiles, [trimmed]: { ...defaultLayout(), name: trimmed } },
      active: trimmed,
      selectedId: null,
    };
    emit();
    schedulePersist();
  },

  /** Rename a profile (and re-point any car bindings + the active pointer). */
  renameProfile(oldName: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || !state.profiles[oldName] || state.profiles[trimmed]) return;
    const profiles: Record<string, Layout> = {};
    for (const [name, layout] of Object.entries(state.profiles)) {
      if (name === oldName) profiles[trimmed] = { ...layout, name: trimmed };
      else profiles[name] = layout;
    }
    const carProfiles = { ...state.carProfiles };
    for (const car of Object.keys(carProfiles)) {
      if (carProfiles[car] === oldName) carProfiles[car] = trimmed;
    }
    state = {
      ...state,
      profiles,
      carProfiles,
      active: state.active === oldName ? trimmed : state.active,
    };
    emit();
    schedulePersist();
  },

  /** Bind the given car model to the active profile (per-car auto-switch). */
  bindCar(carName: string) {
    if (!carName) return;
    state = { ...state, carProfiles: { ...state.carProfiles, [carName]: state.active } };
    emit();
    schedulePersist();
  },

  /** Remove a car→profile binding. */
  unbindCar(carName: string) {
    if (!state.carProfiles[carName]) return;
    const rest = { ...state.carProfiles };
    delete rest[carName];
    state = { ...state, carProfiles: rest };
    emit();
    schedulePersist();
  },

  /** Called when the player's car changes; switches profile if bound. */
  handleCar(carName: string | null) {
    if (carName === lastCar) return;
    lastCar = carName;
    if (!carName) return;
    const target = state.carProfiles[carName];
    if (target && state.profiles[target] && state.active !== target) {
      this.setActive(target);
    }
  },

  deleteProfile(name: string) {
    if (!state.profiles[name] || Object.keys(state.profiles).length <= 1) return;
    const rest = { ...state.profiles };
    delete rest[name];
    const active = state.active === name ? Object.keys(rest)[0] : state.active;
    state = { ...state, profiles: rest, active, selectedId: null };
    emit();
    schedulePersist();
  },
};

function replaceCurrentWithSelection(next: Layout, selectedId: string | null) {
  state = {
    ...state,
    profiles: { ...state.profiles, [state.active]: next },
    selectedId,
  };
  emit();
  schedulePersist();
}

export function useLayout(): LayoutState {
  return useSyncExternalStore(layoutStore.subscribe, layoutStore.snapshot);
}
