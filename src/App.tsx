// Back-compat shim: the overlay surface now lives in OverlayApp. The webview to
// render (manager vs overlay) is chosen by window label in main.tsx.
export { default } from "./OverlayApp";
