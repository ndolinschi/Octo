import { useEffect, useState, type RefObject } from "react";
import { usePageVisible } from "../../lib/hooks";

/**
 * Decision 45: a work-in-progress effect pauses while the window is hidden or its element is off-screen (or in a
 * background tab, display: none). Returns true while it should be paused; the element carries `data-paused`.
 */
export function useAnimationGate(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const visible = usePageVisible();
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, active]);
  return !visible || !onScreen;
}
