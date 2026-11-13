import { useEffect, useRef, type RefObject } from "react";

/**
 * Polish step 6b, R7: `useRowKeys` plus this hook make a list one Tab stop (only the review's lists use it, so it is its own
 * module: `lib/hooks` is in the entry chunk). Like `useRowKeys`, it rebinds when `ref` starts pointing at another element.
 */
export function useRovingRows<T extends HTMLElement>(ref: RefObject<T | null>): void {
  const bound = useRef<T | null>(null);
  const unrove = useRef<(() => void) | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === bound.current) return;
    unrove.current?.();
    unrove.current = el ? rove(el) : null;
    bound.current = el;
  });
  useEffect(
    () => () => {
      unrove.current?.();
      unrove.current = null;
      bound.current = null;
    },
    [],
  );
}

/**
 * Polish step 6b, R7 (`useRovingRows`): the list is one Tab stop. Exactly one `[data-row]` has `tabindex="0"` — the row that
 * last had focus while it is still in the list, else the first — and every other row `-1`; ↑/↓/Home/End move as before. Rows
 * that come and go (a filter, a search) are re-ranked by a MutationObserver, so the list needs nothing else.
 */
function rove(el: HTMLElement): () => void {
  let current: HTMLElement | null = null;
  const apply = () => {
    const rows = [...el.querySelectorAll<HTMLElement>("[data-row]")];
    if (!current || !rows.includes(current)) current = rows[0] ?? null;
    for (const r of rows) {
      const want = r === current ? "0" : "-1";
      if (r.getAttribute("tabindex") !== want) r.setAttribute("tabindex", want);
    }
  };
  const onFocus = (e: FocusEvent) => {
    const row = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-row]") : null;
    if (!row || !el.contains(row) || row === current) return;
    current = row;
    apply();
  };
  apply();
  const mo = new MutationObserver(apply);
  // `tabindex` is written here and is not in the filter, so the observer never answers its own writes.
  mo.observe(el, { childList: true, subtree: true });
  el.addEventListener("focusin", onFocus);
  return () => {
    mo.disconnect();
    el.removeEventListener("focusin", onFocus);
  };
}
