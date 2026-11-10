import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { usePresence } from "./Presence";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour for an overlay panel: focuses `[data-autofocus]` (or the first focusable) on
 * open; Esc closes; Tab cycles inside the panel. Focus goes back to the opener as soon as the
 * overlay starts closing (inside a <Presence>, before its exit animation) or unmounts.
 */
export function useModal(panel: RefObject<HTMLElement | null>, onClose: () => void) {
  const open = usePresence() === "open";
  const close = useRef(onClose);
  const previous = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
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
        e.stopPropagation();
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const nodes = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!nodes.length) return e.preventDefault();
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
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
  }, [panel, open]);

  return open;
}
