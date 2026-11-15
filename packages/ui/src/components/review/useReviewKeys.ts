import { useEffect, type RefObject } from "react";
import { useLatest } from "../../lib/hooks";
import { reviewKeyAction, type ReviewKeyAction } from "../../lib/review/keys";

function isEditable(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "button"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * The review's keys (`j k ] [ v c s`), registered on the review's own root in the capture phase so they work with focus
 * in the diff editor too, and never while a text field has focus. Dialogs are portaled out of the root, so they keep
 * their own keys.
 */
export function useReviewKeys(root: RefObject<HTMLElement | null>, run: (action: ReviewKeyAction) => void): void {
  const latest = useLatest(run);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("[data-pending-panel]")) return;
      const inMonaco = t !== null && t.closest(".monaco-editor") !== null && t.closest(".octo-thread-zone") === null;
      const action = reviewKeyAction(e, { editable: t ? isEditable(t) : false, inMonaco });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current(action);
    };
    el.addEventListener("keydown", onKeyDown, true);
    return () => el.removeEventListener("keydown", onKeyDown, true);
  }, [root, latest]);
}
