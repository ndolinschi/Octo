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

/** How long a restore waits for the transcript to grow tall enough (it is lazy: Markdown, turns mounting as they come near). */
const RESTORE_WAIT_MS = 5000;

/**
 * Scrolls `el` to `top` once the content is tall enough to reach it. Setting it earlier clamps to the end of a still-short
 * transcript, which reads as the reader being at the bottom and makes the view follow the stream down. Gives up after
 * `RESTORE_WAIT_MS` or when the reader scrolls themselves. Returns the cancel function.
 */
export function restoreScrollWhenReachable(el: HTMLElement, top: number, applied: () => void): () => void {
  let done = false;
  const stop = () => {
    done = true;
    ro?.disconnect();
    window.clearTimeout(giveUp);
    for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) el.removeEventListener(name, stop);
  };
  const attempt = () => {
    if (done) return;
    if (el.clientHeight > 0 && el.scrollHeight - el.clientHeight >= top) {
      applied();
      el.scrollTop = top;
      stop();
    }
  };
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(attempt);
  ro?.observe(el);
  if (el.firstElementChild) ro?.observe(el.firstElementChild);
  const giveUp = window.setTimeout(stop, RESTORE_WAIT_MS);
  for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) el.addEventListener(name, stop, { passive: true });
  attempt();
  return stop;
}
