import { useEffect, useRef, type RefObject } from "react";
import { useRowKeys } from "./hooksMore";
import { useRovingRows } from "./rovingRows";

/** Shift+F10 or the context-menu key: the focused row's own menu (11g, as the sidebar's rows). */
export function isRowMenuKey(e: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

/**
 * Item 9 (polish pass F3): a list of `[data-row]` rows is one Tab stop — ↑/↓/Home/End move between the rows (`useRowKeys`,
 * `useRovingRows`) — and a row's "⋯" (any `aria-haspopup="menu"` button beside the row's button) leaves the Tab order: the
 * pointer's way to the row's actions; Shift+F10 on the row (named on the row by `aria-keyshortcuts`) is the keyboard's. A
 * control marked `data-row-control` (a row's checkbox) leaves the Tab order too; its owner gives it a key.
 */
export function useListStops<T extends HTMLElement>(ref: RefObject<T | null>): void {
  useRowKeys(ref);
  useRovingRows(ref);
  // Rebinds when `ref` starts pointing at another element (a list that mounts once its data has loaded), as `useRovingRows`.
  const bound = useRef<T | null>(null);
  const unbind = useRef<(() => void) | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === bound.current) return;
    unbind.current?.();
    unbind.current = el ? bindRowMenus(el) : null;
    bound.current = el;
  });
  useEffect(
    () => () => {
      unbind.current?.();
      unbind.current = null;
      bound.current = null;
    },
    [],
  );
}

function bindRowMenus(el: HTMLElement): () => void {
  const menuOf = (row: Element) => row.parentElement?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null;
  const apply = () => {
    // A row's own control (the review's "Viewed" box: `v` toggles it for the open file) is not a Tab stop of its own either.
    for (const c of el.querySelectorAll<HTMLElement>("[data-row-control]")) if (c.tabIndex !== -1) c.tabIndex = -1;
    for (const row of el.querySelectorAll<HTMLElement>("[data-row]")) {
      const menu = menuOf(row);
      if (!menu || menu === row || row.contains(menu)) continue;
      if (menu.tabIndex !== -1) menu.tabIndex = -1;
      if (row.getAttribute("aria-keyshortcuts") !== "Shift+F10") row.setAttribute("aria-keyshortcuts", "Shift+F10");
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (!isRowMenuKey(e)) return;
    const row = e.target instanceof HTMLElement ? e.target.closest("[data-row]") : null;
    const menu = row && el.contains(row) ? menuOf(row) : null;
    if (!row || !menu || menu === row || row.contains(menu)) return;
    e.preventDefault();
    e.stopPropagation();
    menu.click();
  };
  apply();
  // `tabindex` and `aria-keyshortcuts` are attributes, not children: the observer never answers its own writes.
  const mo = new MutationObserver(apply);
  mo.observe(el, { childList: true, subtree: true });
  el.addEventListener("keydown", onKey);
  return () => {
    mo.disconnect();
    el.removeEventListener("keydown", onKey);
  };
}
