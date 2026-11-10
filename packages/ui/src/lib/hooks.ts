import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return active ? now : Date.now();
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
