import { useEffect, useRef, type RefObject } from "react";
import { usePresence } from "./Presence";
import { useLatest } from "../../lib/hooks";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
const NESTED_OVERLAY = '.octo-overlay, .octo-sheet, [role="menu"], [role="listbox"]';

/**
 * True when an Escape event originated inside a distinct nested overlay (e.g. a portalled popover, menu, listbox, or stacked
 * dialog/sheet) that should handle Escape first. Returns false when focus is still on the opener outside the panel.
 */
export function isEscapeInNestedOverlay(
  target: { closest?(selector: string): Element | null } | null,
  panel: { contains(node: Node): boolean } | null,
): boolean {
  if (!target || !panel || typeof target.closest !== "function") return false;
  if (panel.contains(target as Node)) {
    const nested = target.closest(".octo-overlay, .octo-sheet");
    return nested !== null && nested !== (panel as unknown);
  }
  return target.closest(NESTED_OVERLAY) !== null;
}

/** Focuses `[data-autofocus]`, or the first focusable descendant, falling back to the panel itself when none exists yet. */
export function focusModalPanel(el: Pick<HTMLElement, "querySelector" | "focus"> | null): void {
  if (!el) return;
  const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
  (first ?? el).focus();
}

/**
 * Modal behaviour for an overlay panel: focuses `[data-autofocus]` (or the first focusable, falling back to the panel itself)
 * on open; Esc closes; Tab cycles inside the panel. Focus goes back to the opener as soon as the overlay starts closing
 * (inside a <Presence>, before its exit animation) or unmounts.
 */
export function useModal(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  const open = usePresence() === "open";
  const close = useLatest(onClose);
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusModalPanel(panel.current);
    return restore;
  }, [panel]);

  useEffect(() => {
    if (!open) restore();
  }, [open]);

  function restore() {
    const p = previous.current;
    previous.current = null;
    if (p?.isConnected) p.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A nested overlay (a portalled model picker, menu, listbox, or stacked dialog) closes itself first.
        if (isEscapeInNestedOverlay(e.target instanceof Element ? e.target : null, panel.current)) return;
        // A non-empty search field marked `data-esc-clears` takes the first Esc (it clears itself; the next one closes).
        if (e.target instanceof HTMLInputElement && e.target.dataset.escClears !== undefined && e.target.value) return;
        e.stopPropagation();
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const nodes = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return e.preventDefault();
      if (!panel.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [panel, open, close]);

  return open;
}
