import { useLayoutEffect, useState, type RefObject } from "react";

/** The element's content width, kept current by a ResizeObserver; null before the first measure. */
export function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** The same for an element held in state (a callback ref): measured whenever the element mounts or changes. */
export function useElementWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    // A ResizeObserver reports once on `observe`, before the frame is painted: no synchronous first read needed.
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}
