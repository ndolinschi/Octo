import { useEffect, useState } from "react";

/** How long a press must rest to show a control's description. */
const LONG_PRESS_MS = 550;
/** A finger that moves further than this is scrolling, not pressing. */
const SLOP = 10;
const TIP_SHOWN_MS = 4000;
/** Menus, popovers and pickers that the phone CSS turns into bottom sheets (portalled into `body`). */
const SHEETS = 'body > .octo-overlay.fixed, body > [role="menu"].fixed';

/**
 * Direction 7, two touch rules the primitives get without code of their own:
 * 1. A tap on the scrim of a popup shown as a sheet closes the popup and goes no further: the `click` it would deliver to
 *    whatever lies under the scrim is swallowed (the scrim is a shadow, `styles.css`). When the tap was on the popup's own
 *    opener (which popups ignore as "outside"), an Esc closes it.
 * 2. A long press on a control that has a description (`title`, or the tooltip layer's `data-tip`) shows it in a toast: the
 *    touch stand-in for a tooltip, which never appears on touch. A press that opened a menu shows none.
 * Returns the description to show, or null.
 */
export function useTouchHelpers(): string | null {
  const [tip, setTip] = useState<string | null>(null);
  useEffect(() => {
    let swallow = 0;
    let timer = 0;
    let hide = 0;
    let start: { x: number; y: number } | null = null;
    let shownAt = 0;
    const openSheet = () => [...document.querySelectorAll<HTMLElement>(SHEETS)].find((el) => el.dataset.state !== "closed") ?? null;
    const down = (e: PointerEvent) => {
      const sheet = openSheet();
      const t = e.target;
      if (sheet && t instanceof Node && !sheet.contains(t) && !(t instanceof Element && t.closest(SHEETS))) swallow = Date.now();
      window.clearTimeout(timer);
      setTip(null);
      if (e.pointerType !== "touch" || !(t instanceof Element)) return;
      const el = t.closest<HTMLElement>("[title], [data-tip]");
      const text = el?.dataset.tip ?? el?.getAttribute("title") ?? null;
      if (!text) return;
      start = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => {
        start = null;
        if (document.querySelector('[role="menu"]')) return;
        shownAt = Date.now();
        setTip(text);
        window.clearTimeout(hide);
        hide = window.setTimeout(() => setTip(null), TIP_SHOWN_MS);
      }, LONG_PRESS_MS);
    };
    const move = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) {
        start = null;
        window.clearTimeout(timer);
      }
    };
    const up = () => {
      start = null;
      window.clearTimeout(timer);
    };
    const click = (e: MouseEvent) => {
      // The press that showed a description does not also act.
      const fromTip = shownAt > 0 && Date.now() - shownAt < 1500;
      shownAt = 0;
      if (fromTip || (swallow > 0 && Date.now() - swallow < 1000)) {
        e.preventDefault();
        e.stopPropagation();
        const still = swallow > 0 ? openSheet() : null;
        swallow = 0;
        // Still open: the tap was on its opener. Esc closes every popup (decision 95).
        const at = document.activeElement;
        if (still && at instanceof HTMLElement) at.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return;
      }
      swallow = 0;
    };
    const menu = (e: Event) => {
      if (shownAt > 0) e.preventDefault();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("click", click, true);
    document.addEventListener("contextmenu", menu, true);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(hide);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("contextmenu", menu, true);
    };
  }, []);
  return tip;
}
