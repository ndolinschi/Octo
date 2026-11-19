import { useEffect, type RefObject } from "react";

/**
 * `trackScrollAnchor` (`scrollAnchorTrack.ts`) for the scroller in `ref`; `rebind` changes when the scroller element may have
 * been replaced or only now appeared. The tracker loads with the first conversation (its own chunk, out of the entry): it only
 * matters once the scroller's width changes.
 */
export function useScrollAnchor(ref: RefObject<HTMLElement | null>, itemSelector: string, rebind?: unknown): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let stop: (() => void) | null = null;
    let gone = false;
    // A failed load leaves the position unkept on a width change, as an engine without the tracker would.
    void import("./scrollAnchorTrack").then(
      (m) => {
        if (!gone) stop = m.trackScrollAnchor(el, itemSelector);
      },
      () => undefined,
    );
    return () => {
      gone = true;
      stop?.();
    };
  }, [ref, itemSelector, rebind]);
}
