import { useEffect, useRef, useState, type RefObject } from "react";
import { LOADING_MIN_SHOWN_MS, LOADING_SHOW_AFTER_MS } from "./constants";
import { moveInList } from "./focus";

/* Hooks only lazily loaded views use (lists, loading states): kept out of `hooks.ts`, which the entry chunk carries whole. */

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
 * ↑/↓/Home/End between the `[data-row]` rows inside `ref` (lists of plain buttons: Home, Details). The container may mount
 * after the hook's first render (a list that appears once its data has loaded): every render checks whether `ref` points
 * at another element and rebinds.
 */
export function useRowKeys<T extends HTMLElement>(ref: RefObject<T | null>): void {
  const bound = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === bound.current) return;
    bound.current?.removeEventListener("keydown", moveInList);
    el?.addEventListener("keydown", moveInList);
    bound.current = el;
  });
  useEffect(
    () => () => {
      bound.current?.removeEventListener("keydown", moveInList);
      bound.current = null;
    },
    [],
  );
}
