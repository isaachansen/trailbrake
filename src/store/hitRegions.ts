// Issue 4b — click-through to apps under the edit layer.
//
// While editing, the overlay window now ignores cursor events by DEFAULT (see
// `reconcile_overlay` in src-tauri/src/main.rs), so clicks on empty overlay
// space fall through to whatever app sits on the same monitor. This module is
// the frontend half of what still makes widgets and on-overlay controls
// clickable: a background thread on the Rust side (`spawn_cursor_poll`) flips
// native cursor capture on/off as the OS cursor enters/leaves a set of
// "hit regions" we report here, and forces capture on for the full duration of
// any pointer gesture so a drag/resize can never get stranded mid-gesture (an
// ignoring window receives no pointermove/pointerup at all once the cursor
// leaves the region it started in).
//
// Convention this relies on: every element that wants native capture while
// editing sets its OWN inline `style.pointerEvents = "auto"` — that's already
// true for every such element today (WidgetHost's panel + floating title
// chip, Toolbar's root, SettingsPanel's root, OverlayApp's "Done editing"
// button). Scanning for that convention generically means this module needs
// no markup changes anywhere and automatically tracks any future on-overlay
// control that follows the same pattern. If a future component instead opts
// into capture via a CSS class (rather than an inline style), it won't be
// picked up here — keep using inline `pointerEvents: "auto"` for anything
// that must stay clickable while editing.
//
// No-op outside Tauri (plain-browser dev has no native window to drive).

import { isTauri } from "./transport";

interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function reportHitRegions(regions: HitRect[], forceCapture: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("report_hit_regions", { regions, forceCapture });
  } catch {
    // Best-effort: a dropped IPC call just means one stale poll tick on the
    // Rust side — the next recompute (rAF-scheduled) corrects it.
  }
}

/** Every element under `root` that opts into native capture via its own
 *  inline `pointerEvents: "auto"`, as a window-relative rect. `.overlay-root`
 *  is `position: fixed; inset: 0` over a zero-margin body, so
 *  `getBoundingClientRect()` already gives window-relative CSS-pixel
 *  coordinates with no extra offset math. */
function collectRegions(root: HTMLElement): HitRect[] {
  const regions: HitRect[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.style.pointerEvents !== "auto") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    regions.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return regions;
}

/** Start reporting hit regions (+ pointer-gesture state) for `root` to the
 *  backend's cursor-poll thread. Call while editing; call the returned
 *  cleanup when leaving edit mode / unmounting. */
export function startHitRegionReporting(root: HTMLElement): () => void {
  if (!isTauri()) return () => {};

  let lastRegions: HitRect[] = [];
  let activeGesture = 0;
  let rafHandle: number | null = null;

  const recompute = () => {
    rafHandle = null;
    // Mid-gesture, the window is already fully captured (forceCapture) and
    // precise rects don't matter until the gesture ends — skip the DOM walk.
    if (activeGesture > 0) return;
    lastRegions = collectRegions(root);
    void reportHitRegions(lastRegions, false);
  };

  const scheduleRecompute = () => {
    if (rafHandle != null) return;
    rafHandle = requestAnimationFrame(recompute);
  };

  // Capture-phase so this always sees the gesture even if a target's own
  // handler (e.g. the widget-remove button) calls stopPropagation().
  const onPointerDown = () => {
    activeGesture++;
    if (activeGesture === 1) {
      if (rafHandle != null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      void reportHitRegions(lastRegions, true);
    }
  };
  const onPointerEnd = () => {
    if (activeGesture > 0) activeGesture--;
    if (activeGesture === 0) scheduleRecompute();
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerEnd, true);
  document.addEventListener("pointercancel", onPointerEnd, true);

  // Widget drags/resizes move things purely via inline style changes, and
  // layout edits add/remove widget nodes — both need a recompute.
  const mo = new MutationObserver(() => scheduleRecompute());
  mo.observe(root, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });

  const ro = new ResizeObserver(() => scheduleRecompute());
  ro.observe(root);

  window.addEventListener("resize", scheduleRecompute);

  scheduleRecompute();

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerEnd, true);
    document.removeEventListener("pointercancel", onPointerEnd, true);
    mo.disconnect();
    ro.disconnect();
    window.removeEventListener("resize", scheduleRecompute);
    if (rafHandle != null) cancelAnimationFrame(rafHandle);
    // Defensive — `reconcile_overlay` already clears hit-test state whenever
    // `editing` goes false, but drop it here too in case cleanup ever runs
    // for another reason.
    void reportHitRegions([], false);
  };
}
