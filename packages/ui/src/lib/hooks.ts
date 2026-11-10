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
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, deps);

  return { ref, atBottom, onScroll, scrollToBottom };
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
