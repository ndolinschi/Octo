import { useEffect, type RefObject } from "react";

/**
 * One rule for every popup (`Menu`, `Popover` and so `Select`, `Picker`, the model list, the "+" menu): scrolling closes it
 * only when it leaves its anchor behind.
 *
 * - A scroll inside the popup (any descendant), and a programmatic one (`scrollIntoView` of the active row), never closes it.
 * - A scroll outside closes it only once the anchor sits somewhere else in the window than when the popup opened (more than
 *   `SLOP` px); a scroll elsewhere (a live transcript, a sidebar the anchor is not in) and one that moved nothing leave it.
 * - Resizing the window, Esc, a click outside and a route change close it as before (those are not decided here).
 */

/** Where the anchor sat in the window: its top-left corner. */
export type Spot = { x: number; y: number };

/** The anchor may drift this far (px) before it counts as moved. */
export const SLOP = 1;

export function movedFar(from: Spot, now: Spot): boolean {
  return Math.abs(now.x - from.x) > SLOP || Math.abs(now.y - from.y) > SLOP;
}

/**
 * The page is past its own ends: the elastic bounce of macOS WebKit (WKWebView, Safari) fires `scroll` on the document with
 * a negative offset (or beyond the maximum) while a wheel or trackpad gesture over something that does not scroll, a list that
 * fits, rubber-bands the page. The bounce springs back by itself, so it never closes a popup.
 */
export function overscrolled(at: Spot, max: Spot): boolean {
  return at.x < 0 || at.y < 0 || at.x > max.x + SLOP || at.y > max.y + SLOP;
}

/**
 * Whether a `scroll` event closes the popup. `inside`: the event's target is the popup or lies in it. `from`: the anchor's
 * spot when the popup opened, `null` when there is no anchor to judge by (a menu opened at the pointer on nothing), where any
 * outside scroll closes. `now`: its spot now, `null` when the anchor left the page (that closes).
 */
export function closesOnScroll(e: { inside: boolean; from: Spot | null; now: Spot | null }): boolean {
  if (e.inside) return false;
  if (e.from === null) return true;
  if (e.now === null) return true;
  return movedFar(e.from, e.now);
}

const spotOf = (el: Element | null): Spot | null => {
  if (!el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top };
};

/**
 * Closes the popup on a scroll that moved its anchor (`closesOnScroll`). `popup` is the popup's element, `anchor` the element it
 * hangs on (read when the popup opens and on each scroll; `null` or `document.body` is no anchor). `still` names a scroll
 * target that is the anchor's own (a text field scrolling inside itself) and says nothing about its place: the spot is read
 * again then (the anchor may have hopped, as Monaco's input does on a right click).
 */
export function useCloseOnScroll(open: boolean, popup: RefObject<HTMLElement | null>, anchor: () => Element | null, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const pick = () => {
      const a = anchor();
      return a === document.body || a === document.documentElement ? null : a;
    };
    let from = spotOf(pick());
    const scrolled = (e: Event) => {
      const t = e.target;
      const el = popup.current;
      if (t === document) {
        const root = document.scrollingElement ?? document.documentElement;
        const max = { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight };
        if (overscrolled({ x: window.scrollX, y: window.scrollY }, max)) return;
      }
      const inside = t instanceof Node && (el?.contains(t) ?? false);
      if (inside) return;
      const a = pick();
      if (t === a) {
        from = spotOf(a);
        return;
      }
      // A scroll of a box the anchor is not in cannot have moved it (a reflow aside): it neither closes nor re-bases.
      if (a && t instanceof Node && t !== document && !t.contains(a)) return;
      if (closesOnScroll({ inside, from, now: spotOf(a) })) onClose();
    };
    document.addEventListener("scroll", scrolled, true);
    return () => document.removeEventListener("scroll", scrolled, true);
    // `anchor` is read afresh on each event and is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, popup, onClose]);
}
