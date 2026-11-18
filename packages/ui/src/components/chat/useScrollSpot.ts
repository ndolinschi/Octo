import { useEffect, useMemo, useRef } from "react";
import { useLatest } from "../../lib/hooks";
import { loadSpot, saveSpot, type ScrollSpot } from "../../lib/scrollSpots";

const SAVE_MS = 250;

/**
 * Persists where the reader has scrolled this conversation to, so a reload restores it (the in-memory tab memory only
 * survives a tab moving). Returns the position stored for this conversation when it mounted, or `undefined`.
 * Call `onScroll(scroller)` from the scroller's scroll handler.
 */
export function useScrollSpot(projectId: string, key: string): { stored: ScrollSpot | undefined; onScroll(el: HTMLElement): void } {
  // Read once per conversation, not per render: later saves go to storage only, the in-memory memory wins after that.
  const stored = useMemo(() => loadSpot(projectId, key), [projectId, key]);
  const timer = useRef<number | undefined>(undefined);
  const scroller = useRef<HTMLElement | null>(null);

  const flush = useLatest(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const el = scroller.current;
    // Hidden (a background tab) the scroller reports 0: that says nothing about the reader.
    if (!el || el.clientHeight === 0) return;
    saveSpot(projectId, key, { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 2 });
  });

  useEffect(() => {
    const onHide = () => {
      if (timer.current !== undefined) flush.current();
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.clearTimeout(timer.current);
    };
  }, [flush]);

  return {
    stored,
    onScroll: (el) => {
      scroller.current = el;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush.current(), SAVE_MS);
    },
  };
}

/**
 * Puts a reloaded conversation back at `top`. Usually reachable at once (unmounted turns hold their estimated heights): set
 * now, before any turn mounts and changes the heights the offset was saved against. Otherwise it waits for the content to
 * grow (`restoreScrollWhenReachable`, its own chunk: only a conversation with a saved position needs it; a failed load leaves
 * the view where it opened). Returns the cancel function.
 */
export function restoreScroll(el: HTMLElement, top: number, applied: () => void): () => void {
  if (el.clientHeight > 0 && el.scrollHeight - el.clientHeight >= top) {
    el.scrollTop = top;
    return () => undefined;
  }
  let cancel: (() => void) | null = null;
  let cancelled = false;
  void import("./scrollRestore").then(
    (m) => {
      if (!cancelled) cancel = m.restoreScrollWhenReachable(el, top, applied);
    },
    () => undefined,
  );
  return () => {
    cancelled = true;
    cancel?.();
  };
}
