// Edit mode is a tiny global boolean store.
//
// - In the Tauri app it's driven by a global shortcut handled in Rust (which
//   also flips native click-through) and pushed to the webview via an event.
// - In a plain browser (UI dev / macOS) the `e` key toggles it for testing.
//
// When edit mode is ON: widgets show drag affordances + the perf HUD is visible
// and the overlay captures input. When OFF ("race" mode): chrome hidden, and the
// native window is click-through.

type Listener = () => void;

let editing = false;
const listeners = new Set<Listener>();

export const editModeStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(): boolean {
    return editing;
  },
  set(value: boolean) {
    if (editing === value) return;
    editing = value;
    listeners.forEach((l) => l());
  },
  toggle() {
    this.set(!editing);
  },
};
