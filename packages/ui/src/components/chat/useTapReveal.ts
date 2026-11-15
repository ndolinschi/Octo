import { useEffect, useState, type RefObject } from "react";
import { revealOnTap, REVEAL_MS } from "../../lib/tapReveal";

/**
 * A2 (phone): an action that hover shows on a desktop ("Rewind to here" under a prompt) shows on touch when the person taps
 * the element instead of standing under every one. A tap on the element toggles it; a tap anywhere else or `REVEAL_MS`
 * hides it again. A link, button or a text selection inside the element keeps its own meaning. The listener is a native
 * one on the element (no click handler on a static element). Keyboard and screen readers never need it: the action stays
 * in the DOM and in the tab order, and CSS shows it while it has keyboard focus.
 */
export function useTapReveal(ref: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const coarse = window.matchMedia("(pointer: coarse)");
    const onClick = (e: MouseEvent) => {
      if (!coarse.matches) return;
      const target = e.target instanceof Element ? e.target : null;
      const selected = (window.getSelection()?.toString() ?? "").length > 0;
      if (revealOnTap(target?.closest("a, button, input, textarea, select, summary, [role='button']") != null, selected)) setShown((s) => !s);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [ref]);
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), REVEAL_MS);
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) setShown(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", away, true);
    };
  }, [shown, ref]);
  return shown;
}
