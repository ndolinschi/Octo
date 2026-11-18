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

/** How many candidates from the top edge down are looked at for the innermost one (as many as a screen can hold). */
const NEAR = 40;

type Box = { top: number; bottom: number; empty: boolean };

/**
 * The anchor among `items` (candidates in document order, nested ones allowed) for a viewport whose top is at `edge`: the
 * innermost item at the top edge (a paragraph inside a long answer, not the whole answer) — of the first `NEAR` items whose
 * bottom is below the edge, the first that contains no other. In block flow an item's top is never above an earlier item's,
 * so the first item starting below the edge is found by bisection, and of the items before it only the innermost one still
 * crossing the edge can be among them (an earlier item that is not its ancestor ended above it). `box` is measured only for
 * the few items the search visits (it was every candidate on every scroll event: Stress, P1-6). Items not rendered (an empty
 * box) are stepped over.
 */
export function pickAnchor<T>(
  items: readonly T[],
  box: (item: T) => Box,
  edge: number,
  contains: (a: T, b: T) => boolean,
  parentOf: (item: T) => T | null,
): T | null {
  const firstBelow = (from: number, to: number): number => {
    let lo = from;
    let hi = to;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let probe = mid;
      let b: Box | undefined;
      for (; probe < hi; probe++) {
        const item = items[probe];
        b = item === undefined ? undefined : box(item);
        if (b && !b.empty) break;
      }
      if (probe >= hi || !b) hi = mid;
      else if (b.top > edge + 1) hi = mid;
      else lo = probe + 1;
    }
    return lo;
  };
  const start = firstBelow(0, items.length);
  // The innermost item crossing the edge: the one just before `start` if it does, else that one's nearest crossing ancestor.
  let crossing: T | null = null;
  for (let i = start - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) break;
    const b = box(item);
    if (b.empty) continue;
    for (let at: T | null = item; at; at = parentOf(at)) {
      if (box(at).bottom > edge + 1) {
        crossing = at;
        break;
      }
    }
    break;
  }
  const near = [...(crossing ? [crossing] : []), ...items.slice(start, start + NEAR).filter((e) => !box(e).empty)].slice(0, NEAR);
  return near.find((c) => !near.some((o) => o !== c && contains(c, o))) ?? null;
}

export function trackScrollAnchor(scroller: HTMLElement, itemSelector: string): () => void {
  let anchor: { el: Element; offset: number } | null = null;
  let atEnd = true;
  let width = scroller.clientWidth;
  const top = () => scroller.getBoundingClientRect().top;
  // The candidates, read again only after the content changed (turns mount and unmount as the reader scrolls).
  let items: Element[] | null = null;
  const changed = new MutationObserver(() => {
    items = null;
  });
  changed.observe(scroller, { childList: true, subtree: true });
  const parentOf = (el: Element): Element | null => {
    const up = el.parentElement?.closest(itemSelector) ?? null;
    return up && scroller.contains(up) ? up : null;
  };
  const boxOf = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, empty: r.width === 0 && r.height === 0 };
  };
  const remember = () => {
    const edge = top();
    items ??= [...scroller.querySelectorAll(itemSelector)];
    const el = pickAnchor(items, boxOf, edge, (a, b) => a.contains(b), parentOf);
    anchor = el ? { el, offset: el.getBoundingClientRect().top - edge } : null;
    atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
  };
  remember();
  let settleUntil = 0;
  // Once per frame however many scroll events it brings (wheel and touch scrolling send several).
  let frame = 0;
  const rememberSoon = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // The width changed since the scroll: the resize observer restores and remembers with the old anchor.
      if (scroller.clientWidth === width && performance.now() >= settleUntil) remember();
    });
  };
  // While the position is being held after a width change, a scroll that is not the user's (a layout effect of the host
  // moving `scrollTop`) is put back; otherwise the scroll is the reader moving and becomes the new anchor.
  const onScroll = () => {
    // The width already changed but the resize observer has not run: this scroll is the engine's own anchoring, not the reader.
    if (scroller.clientWidth !== width) return;
    if (performance.now() < settleUntil) restore();
    else rememberSoon();
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
    cancelAnimationFrame(frame);
    changed.disconnect();
    ro.disconnect();
  };
}
