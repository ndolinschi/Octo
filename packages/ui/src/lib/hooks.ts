import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** Idle clocks only move for relative times ("2h ago"). */
const IDLE_TICK = 60_000;

/**
 * A clock that ticks every `intervalMs` while `active`, and once a minute otherwise. The value is
 * stable between ticks, so memoised children that take it (the transcript) don't re-render on
 * unrelated updates such as scrolling.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), active ? intervalMs : IDLE_TICK);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
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

const STICK_THRESHOLD = 80;

export function useStickToBottom<T extends HTMLElement>(deps: unknown[], initialStick = true) {
  const ref = useRef<T>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(initialStick);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    const animate = smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

  // Reflow (a group resized, a prompt expanded, the composer shrank) keeps a reader at the bottom there.
  const observed = useRef<{ el: Element; ro: ResizeObserver } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.ro.disconnect();
    observed.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current && el.offsetParent !== null) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    observed.current = { el, ro };
  });
  useEffect(() => () => observed.current?.ro.disconnect(), []);

  return { ref, atBottom, onScroll, scrollToBottom, release };
}

export function useCopy(timeoutMs = 1400): [boolean, (text: string) => void] {
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
  const handler = useRef(onEscape);
  useLayoutEffect(() => {
    handler.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) handler.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);
}

/** Loading indicators wait this long before showing, then stay at least `MIN_SHOWN` once shown. */
const SHOW_AFTER = 200;
const MIN_SHOWN = 300;

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
      }, SHOW_AFTER);
      return () => window.clearTimeout(id);
    }
    if (!loading && shown) {
      const id = window.setTimeout(() => setShown(false), Math.max(0, since.current + MIN_SHOWN - Date.now()));
      return () => window.clearTimeout(id);
    }
  }, [loading, shown]);
  return shown;
}
