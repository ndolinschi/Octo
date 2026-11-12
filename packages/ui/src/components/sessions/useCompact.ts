import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isCompact } from "../../lib/sessions/model";

/** Whether the element is narrower than the conversation's own floor (420 px): its transcript is drawn compact. Measured, re-measured on resize. */
export function useCompact(): { ref: RefObject<HTMLDivElement | null>; compact: boolean } {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCompact(isCompact(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, compact };
}
