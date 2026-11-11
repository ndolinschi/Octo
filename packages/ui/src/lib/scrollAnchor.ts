import { useEffect, type RefObject } from "react";

/**
 * Keeps a scroller's reading position when its width changes (decision 60: opening a file narrows the conversation and the
 * text re-wraps, so everything below the top of the viewport changes height). While the user scrolls, the first item whose
 * bottom is in view is remembered together with its offset from the scroller's top; when the scroller's width changes,
 * `scrollTop` is moved so that item is back at that offset, before the next paint. `itemSelector` lists the anchor candidates
 * in document order, nested ones allowed (the innermost one at the top edge wins). A scroller at its end is left alone (a
 * conversation that follows the latest message does so by itself). WebKit has no CSS scroll anchoring, so this is done by hand.
 * Returns the cleanup.
 */
/** How long after a width change the content's own size changes still restore the reading position. */
const SETTLE_MS = 300;

export function trackScrollAnchor(scroller: HTMLElement, itemSelector: string): () => void {
  let anchor: { el: Element; offset: number } | null = null;
  let atEnd = true;
  let width = scroller.clientWidth;
  const top = () => scroller.getBoundingClientRect().top;
  const remember = () => {
    const edge = top();
    // The innermost item at the top edge (a paragraph inside a long answer, not the whole answer): the first few
    // candidates whose bottom is in view, the first of those that contains no other.
    const near = [...scroller.querySelectorAll(itemSelector)].filter((e) => e.getBoundingClientRect().bottom > edge + 1).slice(0, 40);
    const el = near.find((c) => !near.some((o) => o !== c && c.contains(o)));
    anchor = el ? { el, offset: el.getBoundingClientRect().top - edge } : null;
    atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
  };
  remember();
  let settleUntil = 0;
  // While the position is being held after a width change, a scroll that is not the user's (a layout effect of the host
  // moving `scrollTop`) is put back; otherwise the scroll is the reader moving and becomes the new anchor.
  const onScroll = () => {
    // The width already changed but the resize observer has not run: this scroll is the engine's own anchoring, not the reader.
    if (scroller.clientWidth !== width) return;
    if (performance.now() < settleUntil) restore();
    else remember();
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  const restore = () => {
    if (atEnd || !anchor?.el.isConnected) return;
    // A correction can itself change what is laid out (a pinned prompt appears), so settle in a few passes.
    for (let pass = 0; pass < 3; pass++) {
      const delta = anchor.el.getBoundingClientRect().top - top() - anchor.offset;
      if (Math.abs(delta) <= 0.5) break;
      scroller.scrollTop += delta;
    }
  };
  // The narrower column can re-wrap again a moment later (the conversation switches to its compact layout at its own
  // width), so size changes of the content keep restoring the position for a short while after the width changed.
  const ro = new ResizeObserver((entries) => {
    const next = scroller.clientWidth;
    if (next !== width) {
      width = next;
      settleUntil = performance.now() + SETTLE_MS;
      restore();
      remember();
    } else if (performance.now() < settleUntil && entries.some((e) => e.target !== scroller)) {
      restore();
      remember();
    }
  });
  ro.observe(scroller);
  for (const child of scroller.children) ro.observe(child);
  return () => {
    scroller.removeEventListener("scroll", onScroll);
    ro.disconnect();
  };
}

/** `trackScrollAnchor` for the scroller in `ref`; `rebind` changes when the scroller element may have been replaced or only now appeared. */
export function useScrollAnchor(ref: RefObject<HTMLElement | null>, itemSelector: string, rebind?: unknown): void {
  useEffect(() => {
    const el = ref.current;
    return el ? trackScrollAnchor(el, itemSelector) : undefined;
  }, [ref, itemSelector, rebind]);
}
