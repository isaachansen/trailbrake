// Makes a widget's content fit its box. Widgets are authored at a fixed font
// size, so when a box is smaller than the content needs, the content used to be
// clipped (cut off at the bottom). This wrapper measures the content's natural
// size and scales it down to fit, so nothing is ever cut off — and the widget
// scales with the box (responsive) instead of just clipping.
//
// It only ever scales *down* (never magnifies past the authored size): a box
// bigger than the content keeps the content at its native size. Widgets that
// already fill their box exactly (the canvas/draw widgets, which size themselves
// from the `size` prop) never overflow, so they measure as scale 1 and render
// untouched at full resolution.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  /** Renders the widget at the given (virtual, pre-scale) size. */
  children: (size: { w: number; h: number }) => ReactNode;
}

export function FitContent({ children }: Props) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  // Bumped whenever something that affects the fit changes (box size or the
  // widget's content). Each bump triggers a fresh "reset to 1, then shrink" pass.
  const [fitKey, setFitKey] = useState(0);

  // Track the box size (the space the widget is given), and re-fit on content
  // changes — data-driven widgets render their rows only once telemetry arrives,
  // which happens after the first measure. A MutationObserver (coalesced to one
  // animation frame) catches that and any later row add/remove. We watch only
  // structural changes (childList), not text: several widgets rewrite their text
  // every frame via refs to avoid React re-renders, and watching characterData
  // would force a re-fit at 60fps and defeat that.
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const ro = new ResizeObserver(() => {
      const w = outer.clientWidth;
      const h = outer.clientHeight;
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    });
    ro.observe(outer);

    let raf = 0;
    const mo = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setFitKey((k) => k + 1);
      });
    });
    mo.observe(inner, { childList: true, subtree: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // A fit pass starts from the natural size (scale 1) so the measurement below
  // sees the true content height. Runs on box change and on every content bump.
  useLayoutEffect(() => {
    setScale(1);
  }, [box.w, box.h, fitKey]);

  // Measure the widget's own root(s) — not this wrapper. Widgets set
  // `height: 100%; overflow: hidden` on their root, which clips their content
  // *inside* the root, so the overflow never reaches the wrapper's scrollHeight.
  // The root's own scrollWidth/Height still report the full content size. We only
  // ever shrink here (the effect above reset to 1 first), so widgets whose text
  // reflows with width can't oscillate — the scale settles in a pass or two.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || box.w === 0 || box.h === 0) return;
    let sw = 0;
    let sh = 0;
    for (const child of Array.from(inner.children) as HTMLElement[]) {
      sw = Math.max(sw, child.scrollWidth);
      sh = Math.max(sh, child.scrollHeight);
    }
    if (sw === 0 || sh === 0) return;
    // 1px slack so sub-pixel rounding doesn't trigger a needless shrink.
    const s = Math.min(1, box.w / Math.max(sw - 1, 1), box.h / Math.max(sh - 1, 1));
    if (s < scale - 0.004) setScale(s);
  });

  // Render the widget into a virtual box that's larger by 1/scale, then scale the
  // whole thing down to the real box — so after scaling it fills the box exactly.
  const vw = scale > 0 ? box.w / scale : box.w;
  const vh = scale > 0 ? box.h / scale : box.h;

  return (
    <div ref={outerRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        ref={innerRef}
        style={{ width: vw, height: vh, transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        {box.w > 0 && children({ w: vw, h: vh })}
      </div>
    </div>
  );
}
