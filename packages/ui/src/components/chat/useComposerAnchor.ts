import { useLayoutEffect, type RefObject } from "react";
import { useLatest } from "../../lib/hooks";

/**
 * Decision 62: the composer growing or shrinking never moves the conversation's last visible line. A reader at the end
 * is kept there by the scroller itself; a reader scrolled up gets the height change added to (or taken from) the
 * scroll position, so the text under their eyes stays put.
 */
export function useComposerAnchor(scroller: RefObject<HTMLElement | null>, composer: RefObject<HTMLElement | null>, atBottom: boolean): void {
  const following = useLatest(atBottom);
  useLayoutEffect(() => {
    const row = composer.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    let height = row.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const next = row.getBoundingClientRect().height;
      // Hidden (a background tab): the row has no height, which is not the composer shrinking. Keeping 0 made the tab
      // coming back read as the composer growing by its whole height, and the reader's place moved by that much.
      if (next === 0) return;
      // Mounted hidden: the first height seen is where it starts, not a change.
      const delta = height === 0 ? 0 : next - height;
      height = next;
      const el = scroller.current;
      if (!delta || !el || following.current) return;
      el.scrollTop += delta;
    });
    ro.observe(row);
    return () => ro.disconnect();
  }, [scroller, composer, following]);
}
