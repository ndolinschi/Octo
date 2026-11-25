import { useEffect, type RefObject } from "react";
import type { TabId } from "./layout";
import { walkPress } from "./tabStrip";
import type { TabKeysApi } from "./tabKeys";

/**
 * The tab shortcuts (decision 25), in the capture phase so they work inside Monaco: Ctrl/Cmd+W close,
 * Ctrl/Cmd+Shift+T reopen, Ctrl+Tab / Ctrl+Shift+Tab walk the tabs in most-recently-used order while Ctrl is held,
 * Ctrl/Cmd+1…9 jump, Ctrl/Cmd+Shift+PageUp/PageDown move the tab, Ctrl/Cmd+\\ move it to the other side, Ctrl/Cmd+T opens
 * the "+" tab picker, Ctrl/Cmd+; the side question (decision 40), Ctrl/Cmd+Shift+Enter maximise / restore the tab's group
 * (decision 78; Esc restores too: `dock/MaximiseEffects`).
 * `target` is the tab a shortcut means (a focused tab button, else the focused group's active tab).
 */
export function useTabKeys(ws: RefObject<TabKeysApi>, target: () => TabId) {
  useEffect(() => {
    // The listeners load at once, in their own chunk (`tabKeys.ts`); a failed load leaves the shortcuts off until a reload.
    let off: (() => void) | null = null;
    let alive = true;
    import("./tabKeys").then(
      (m) => {
        if (alive) off = m.listenTabKeys(ws, target, walkPress);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      off?.();
    };
  }, [ws, target]);
}
