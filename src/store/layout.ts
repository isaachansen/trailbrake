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
  /** VR-only: metres nearer (−) / farther (+) than the global panel distance. */
  vrDepth: number;
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
}

interface LayoutState {
  active: string;
  profiles: Record<string, Layout>;
  carProfiles: Record<string, string>;
  defaults: OverlayDefaults;
  selectedId: string | null;
  loaded: boolean;
}

/** A widget's effective scale (its own, or the inherited global default). */
function scaleOf(inst: WidgetInstance, defaults: OverlayDefaults): number {
  return inst.useGeneralScale ? defaults.scale : inst.scale;
}

/**
 * Smallest box (real px) that keeps a widget's content un-squished at its
 * effective scale. Width is content-aware (`minContentWidth`, which tracks the
 * columns currently enabled) and height is the definition floor; both scale with
 * the font, since the widgets lay out in em. Used to clamp resize and scale so a
 * widget can never be shrunk/scaled into a clipped or squished state.
 */
function minSizePx(inst: WidgetInstance, defaults: OverlayDefaults): { w: number; h: number } {
  const def = getWidgetDef(inst.type);
  if (!def) return { w: 60, h: 40 };
  const scale = scaleOf(inst, defaults);
  const baseW = def.minContentWidth?.(inst.config as any) ?? def.minSize.w;
  return { w: Math.ceil(baseW * scale), h: Math.ceil(def.minSize.h * scale) };
}

/** Grow `inst`'s box up to its minimum if it's smaller; otherwise return as-is. */
function clampSize(inst: WidgetInstance, defaults: OverlayDefaults): WidgetInstance {
  const min = minSizePx(inst, defaults);
  if (inst.size.w >= min.w && inst.size.h >= min.h) return inst;
  return { ...inst, size: { w: Math.max(inst.size.w, min.w), h: Math.max(inst.size.h, min.h) } };
}

/** True when v is a finite number — guards persisted JSON against NaN/strings. */
function finiteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeDefaults(d: Partial<OverlayDefaults> | undefined): OverlayDefaults {
  return {
    opacity: finiteNum(d?.opacity) ? d!.opacity! : DEFAULT_DEFAULTS.opacity,
    scale: finiteNum(d?.scale) ? d!.scale! : DEFAULT_DEFAULTS.scale,
    // Filter to valid state keys (same as migrateShowIn) so a corrupt blob can't
    // smuggle garbage into every inheriting widget's visibility gate.
    showIn: Array.isArray(d?.showIn)
      ? d!.showIn.filter((s): s is SessionStateKey => ALL_SESSION_STATES.includes(s as SessionStateKey))
      : [...DEFAULT_DEFAULTS.showIn],
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
    vrDepth: 0,
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

/**
 * True once a sync message from another window has been applied. `init()`'s
 * disk read and the other window's initial broadcast race; if the broadcast
 * lands first (e.g. this window started after edits were already made
 * elsewhere), the disk load resolving afterwards must not clobber it with a
 * stale snapshot — see `init()`.
 */
let externalApplied = false;

function currentBlob(): ConfigBlob {
  return {
    version: CONFIG_VERSION,
    active: state.active,
    profiles: state.profiles,
    carProfiles: state.carProfiles,
    defaults: state.defaults,
  };
}

// --- persistence (debounced) + broadcast (faster, so other windows feel live) ---
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

/** Write the current blob to disk; a failure is logged and retried once so a
 *  transient FS error doesn't silently revert the layout on next launch. */
function persistNow() {
  const data = JSON.stringify(currentBlob());
  saveConfig(data).catch((err) => {
    console.error("Layout save failed, retrying once:", err);
    saveConfig(data).catch((err2) => console.error("Layout save retry failed — changes may not persist:", err2));
  });
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 400);
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
function normalizeProfiles(profiles: Record<string, Layout>, defaults: OverlayDefaults): Record<string, Layout> {
  const out: Record<string, Layout> = {};
  for (const [name, layout] of Object.entries(profiles)) {
    const widgets = (layout?.widgets ?? [])
      .map((w, i) => {
        const def = getWidgetDef(w.type);
        if (!def) return null;
        // A corrupt/hand-edited config file can carry a widget with a missing or
        // non-finite position/size; fall back to a staggered default position and
        // the widget's own default size rather than letting NaN/undefined reach
        // rendering (which would blank the whole overlay — WidgetHost reads these
        // directly into inline styles).
        const rawPos = (w as { position?: { x?: unknown; y?: unknown } }).position;
        const rawSize = (w as { size?: { w?: unknown; h?: unknown } }).size;
        const position =
          finiteNum(rawPos?.x) && finiteNum(rawPos?.y)
            ? { x: rawPos!.x as number, y: rawPos!.y as number }
            : { x: 40 + i * 24, y: 40 + i * 24 };
        const size =
          finiteNum(rawSize?.w) && finiteNum(rawSize?.h) && (rawSize!.w as number) > 0 && (rawSize!.h as number) > 0
            ? { w: rawSize!.w as number, h: rawSize!.h as number }
            : { ...def.defaultSize };
        const inst: WidgetInstance = {
          ...w,
          instanceId: typeof w.instanceId === "string" && w.instanceId ? w.instanceId : uid(),
          position,
          size,
          opacity: finiteNum(w.opacity) ? w.opacity : DEFAULT_DEFAULTS.opacity,
          scale: finiteNum(w.scale) ? w.scale : 1,
          showIn: migrateShowIn((w as { showIn?: unknown }).showIn),
          useGeneralOpacity: w.useGeneralOpacity ?? true,
          useGeneralScale: w.useGeneralScale ?? true,
          useGeneralShowIn: w.useGeneralShowIn ?? true,
          vrDepth: finiteNum(w.vrDepth) ? w.vrDepth : 0,
          config: { ...structuredClone(def.defaultConfig), ...(w.config ?? {}) },
        };
        // Heal layouts saved before content-aware minimums existed: a widget
        // stored too narrow for its columns is grown so it loads un-squished.
        return clampSize(inst, defaults);
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
        profiles: normalizeProfiles(blob.profiles, normalizeDefaults(blob.defaults)),
        carProfiles: blob.carProfiles ?? {},
        defaults: normalizeDefaults(blob.defaults),
        selectedId: stillThere ? state.selectedId : null,
        loaded: true,
      };
      externalApplied = true;
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

  /** Re-broadcast the current blob immediately (bypassing the debounce). Used to
   *  answer another window's just-opened "resend your state" request, since a
   *  broadcast sent before that window's listener registered would otherwise be
   *  lost — see `sync.ts`'s startup handshake. */
  broadcastNow() {
    broadcaster?.(JSON.stringify(currentBlob()));
  },

  /** Global overlay defaults (inherited by widgets via their useGeneral* flags). */
  getDefaults(): OverlayDefaults {
    return state.defaults;
  },
  setDefault(partial: Partial<OverlayDefaults>) {
    const defaults = { ...state.defaults, ...partial };
    state = { ...state, defaults };
    // Raising the global scale enlarges em-based content, so widgets inheriting
    // it must grow to stay un-squished. Re-clamp the active profile's inheritors.
    if (partial.scale != null) {
      const layout = current();
      const widgets = layout.widgets.map((w) => (w.useGeneralScale ? clampSize(w, defaults) : w));
      state = { ...state, profiles: { ...state.profiles, [state.active]: { ...layout, widgets } } };
    }
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
    // A sync broadcast from another window already landed while this disk read
    // was in flight — it's necessarily fresher than what's on disk, so applying
    // the disk snapshot now would silently discard it. Just mark loaded.
    if (externalApplied) {
      state = { ...state, loaded: true };
      emit();
      return;
    }
    if (raw) {
      try {
        const blob = JSON.parse(raw) as ConfigBlob;
        if (blob.profiles && Object.keys(blob.profiles).length) {
          const active = blob.profiles[blob.active] ? blob.active : Object.keys(blob.profiles)[0];
          state = {
            active,
            profiles: normalizeProfiles(blob.profiles, normalizeDefaults(blob.defaults)),
            carProfiles: blob.carProfiles ?? {},
            defaults: normalizeDefaults(blob.defaults),
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
      widgets: layout.widgets.map((w) => (w.instanceId === id ? clampSize({ ...w, ...partial }, state.defaults) : w)),
    });
  },

  updateConfig(id: string, partial: Record<string, unknown>) {
    const layout = current();
    replaceCurrent({
      ...layout,
      // Re-clamp: toggling a column changes the content-aware minimum width, so a
      // box that fit the trimmed set must grow when columns are turned back on.
      widgets: layout.widgets.map((w) =>
        w.instanceId === id ? clampSize({ ...w, config: { ...w.config, ...partial } }, state.defaults) : w
      ),
    });
  },

  /** Smallest box (real px) this widget can occupy without squishing — see `minSizePx`. */
  minSizeFor(inst: WidgetInstance): { w: number; h: number } {
    return minSizePx(inst, state.defaults);
  },

  resetConfig(id: string) {
    const layout = current();
    replaceCurrent({
      ...layout,
      widgets: layout.widgets.map((w) => {
        if (w.instanceId !== id) return w;
        const def = getWidgetDef(w.type);
        if (!def) return w;
        const freshConfig = structuredClone(def.defaultConfig);
        // Mirror the manager's content-driven resize (WidgetConfigEditor's
        // setConfig): a reset can turn sections back on, so grow/shrink by the
        // same delta a manual toggle would, then clamp to the content floor —
        // otherwise restored content renders squeezed into the old box.
        let size = w.size;
        if (def.contentHeight) {
          const deltaDesign = def.contentHeight(freshConfig as never) - def.contentHeight(w.config as never);
          if (deltaDesign !== 0) {
            const eff = scaleOf(w, state.defaults);
            size = { w: w.size.w, h: Math.max(0, Math.round(w.size.h + deltaDesign * eff)) };
          }
        }
        return clampSize({ ...w, config: freshConfig, size }, state.defaults);
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

  /**
   * Create a new profile as a copy of the *currently active* layout (not the
   * stock default — switching to a fresh profile shouldn't blow away the setup
   * you were just looking at). Returns an error message on an empty/duplicate
   * name, or null on success, so the caller can show it instead of a silent
   * no-op.
   */
  newProfile(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return "Enter a profile name.";
    if (state.profiles[trimmed]) return `A profile named "${trimmed}" already exists.`;
    const source = current();
    const cloned: Layout = {
      name: trimmed,
      // Fresh instance ids: profiles are independent, and reusing ids across
      // them would let a stale selection in one profile match a widget in another.
      widgets: structuredClone(source.widgets).map((w) => ({ ...w, instanceId: uid() })),
    };
    state = {
      ...state,
      profiles: { ...state.profiles, [trimmed]: cloned },
      active: trimmed,
      selectedId: null,
    };
    emit();
    schedulePersist();
    return null;
  },

  /** Rename a profile (and re-point any car bindings + the active pointer).
   *  Returns an error message on an empty/duplicate name, or null on success. */
  renameProfile(oldName: string, newName: string): string | null {
    const trimmed = newName.trim();
    if (!trimmed) return "Enter a profile name.";
    if (!state.profiles[oldName]) return `Profile "${oldName}" no longer exists.`;
    if (trimmed === oldName) return null;
    if (state.profiles[trimmed]) return `A profile named "${trimmed}" already exists.`;
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
    return null;
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
