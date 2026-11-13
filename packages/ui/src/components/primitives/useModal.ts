import { useEffect, useRef, type RefObject } from "react";
import { usePresence } from "./Presence";
import { useLatest } from "../../lib/hooks";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour for an overlay panel: focuses `[data-autofocus]` (or the first focusable) on
 * open; Esc closes; Tab cycles inside the panel. Focus goes back to the opener as soon as the
 * overlay starts closing (inside a <Presence>, before its exit animation) or unmounts.
 */
export function useModal(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  const open = usePresence() === "open";
  const close = useLatest(onClose);
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
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
        // A popover opened from the panel (a model picker) is portalled outside it and closes itself first.
        if (e.target instanceof Node && panel.current && !panel.current.contains(e.target) && document.activeElement !== document.body) return;
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
