import { useEffect, type RefObject } from "react";
import { useLatest } from "../../lib/hooks";
import { useInlineNotes } from "./notesContext";

/**
 * Ctrl/Cmd+Shift+U is listed as "Context details" (Keyboard shortcuts). The ring answers it while it is shown; before the
 * first turn there are no numbers and no ring, and the key did nothing. Then the composer answers instead, with the same
 * report `/context` shows. Only a composer that is laid out answers (a conversation kept alive in a hidden tab does not).
 */
export function useContextShortcut(composer: RefObject<HTMLElement | null>, ringShown: boolean): void {
  const push = useLatest(useInlineNotes()?.push);
  useEffect(() => {
    if (ringShown) return undefined;
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "u") return;
      const el = composer.current;
      if (!el || el.getClientRects().length === 0 || !push.current) return;
      e.preventDefault();
      push.current({ kind: "context" });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [composer, ringShown, push]);
}
