import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CLOCK_IDLE_MS, COPY_FEEDBACK_MS, LOADING_MIN_SHOWN_MS, LOADING_SHOW_AFTER_MS, NOW_ACTIVE_MS } from "./constants";
import { moveInList } from "./focus";

/**
 * A ref that always holds the latest `value`, updated in a layout effect (after the commit, before any event or effect can
 * read it). For callbacks and effects that must see current props or state without re-subscribing.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * A clock that ticks every `intervalMs` while `active`, and once a minute otherwise. The value is
 * stable between ticks, so memoised children that take it (the transcript) don't re-render on
 * unrelated updates such as scrolling.
 */
export function useNow(active: boolean, intervalMs = NOW_ACTIVE_MS, paused = false): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Paused (a hidden tab or page): no timer at all; the clock catches up when it shows again.
    if (paused) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), active ? intervalMs : CLOCK_IDLE_MS);
    return () => window.clearInterval(id);
  }, [active, intervalMs, paused]);
  return now;
}

/** Whether the page is visible (`document.visibilityState`); polling and clocks stop while it is not (decision 36). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Further than this from the end, something is cut off below: the reader is no longer at the end. */
const END_TOLERANCE = 2;

/**
 * Follows new content while the reader is at the end. "At the end" is strict (nothing hidden below, 2px
 * tolerance): a reader who stopped a few lines short always gets Jump to latest, and the last line is
 * never left under the composer. A view hidden by its tab (display: none) keeps its intent: shown again,
 * it returns to the end. Scroll events of the smooth Jump-to-latest animation are not the reader's.
 */
export function useStickToBottom<T extends HTMLElement>(deps: unknown[], initialStick = true) {
  const ref = useRef<T>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(initialStick);
  const hidden = useRef(false);
  const gliding = useRef(false);
  const lastTop = useRef(0);

  const onScroll = useCallback(() => {
    const el = ref.current;
    // Scroll events from hiding/showing the tab (scrollTop reset) say nothing about the reader.
    if (!el || hidden.current || el.clientHeight === 0) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight <= END_TOLERANCE;
    const movedUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    if (gliding.current) {
      if (!end) return;
      gliding.current = false;
    }
    // A reflow (the group resized, a tab moved) that leaves a following reader short of the end is not
    // the reader scrolling away: only scrolling up lets go.
    if (!end && atBottomRef.current && !movedUp) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    atBottomRef.current = end;
    setAtBottom(end);
  }, []);

  /** Back to the end if the reader was following (a hidden tab shown again). */
  const restick = useCallback(() => {
    const el = ref.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    setAtBottom(true);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    const animate = smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gliding.current = animate;
    el.scrollTo({ top: el.scrollHeight, behavior: animate ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  /** Stop following new content (before a programmatic scroll elsewhere). */
  const release = useCallback(() => {
    atBottomRef.current = false;
    setAtBottom(false);
  }, []);

  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, deps);

  // Reflow (a group resized, a prompt expanded, the composer shrank) keeps a reader at the bottom there;
  // coming back from hidden (the tab was in the background while the turn went on) returns to the end.
  const observed = useRef<{ el: Element; ro: ResizeObserver } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === 0) {
        hidden.current = true;
        return;
      }
      const wasHidden = hidden.current;
      hidden.current = false;
      if (atBottomRef.current) {
        el.scrollTop = el.scrollHeight;
        if (wasHidden) setAtBottom(true);
      }
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    observed.current = { el, ro };
  });
  useEffect(() => () => observed.current?.ro.disconnect(), []);

  return { ref, atBottom, onScroll, scrollToBottom, release, restick };
}

export function useCopy(timeoutMs = COPY_FEEDBACK_MS): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), timeoutMs);
        },
        () => undefined,
      );
    },
    [timeoutMs],
  );
  return [copied, copy];
}

/** Calls `onEscape` for Escape presses that nothing inside the page already handled. */
export function useEscape(active: boolean, onEscape: () => void) {
  const handler = useLatest(onEscape);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) handler.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, handler]);
}

/**
 * Whether to show a loading indicator for `loading`: never for loads under 200ms (no flash), and
 * once shown, for at least 300ms (no flicker). While it returns true, keep showing the indicator
 * even if the data has arrived.
 */
export function useDelayedLoading(loading: boolean): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (loading && !shown) {
      const id = window.setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, LOADING_SHOW_AFTER_MS);
      return () => window.clearTimeout(id);
    }
    if (!loading && shown) {
      const id = window.setTimeout(() => setShown(false), Math.max(0, since.current + LOADING_MIN_SHOWN_MS - Date.now()));
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [loading, shown]);
  return shown;
}

/**
 * Fades whichever end of a scroller has more content (`data-fade="start end"`, styled by the `fade-x` /
 * `fade-y` utilities): the cue for lists whose scrollbar is hidden so their rows keep the panel's insets.
 * Returns an updater to call after programmatic scrolls.
 */
export function useScrollFade<T extends HTMLElement>(ref: RefObject<T | null>, axis: "x" | "y"): () => void {
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const [pos, size, total] = axis === "x" ? [el.scrollLeft, el.clientWidth, el.scrollWidth] : [el.scrollTop, el.clientHeight, el.scrollHeight];
    const fade = [pos > 1 && "start", pos + size < total - 1 && "end"].filter(Boolean).join(" ");
    if ((el.dataset.fade ?? "") !== fade) el.dataset.fade = fade;
  }, [ref, axis]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, update]);
  return update;
}

/** ↑/↓/Home/End between the `[data-row]` rows inside `ref` (lists of plain buttons: Home, Details). */
export function useRowKeys<T extends HTMLElement>(ref: RefObject<T | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("keydown", moveInList);
    return () => el.removeEventListener("keydown", moveInList);
  }, [ref]);
}
