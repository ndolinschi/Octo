import { useEffect, type RefObject } from "react";
import type { TabId } from "./layout";
import { walkPress, type TabWalk } from "./tabStrip";

/** The part of the workspace the shortcuts drive (structural, so this hook does not import the provider). */
type TabKeysApi = {
  mruOrder(): TabId[];
  /** The group the walk belongs to (the focused group, or the one strip when narrow). */
  walkGroup(): string;
  cycle(step: number, order: TabId[]): void;
  endCycle(): void;
  moveToOtherSide(tab: TabId): void;
  requestClose(tabs: TabId[]): void;
  reopenClosed(): void;
  moveBy(tab: TabId, delta: -1 | 1): void;
  jump(digit: number): void;
  openPicker(): void;
  openTool(tool: "side"): void;
  /** Decision 78: whole-dock mode for the group of `tab`. */
  toggleMaximise(tab: TabId, on?: boolean): void;
};

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
    let walk: TabWalk<TabId> | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const w = ws.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") {
        return run(() => {
          // Decision 25: the walk stays in the group it started in while Ctrl is held (tabStrip.walkPress).
          const next = walkPress(walk, { group: w.walkGroup(), order: walk ? [] : w.mruOrder() }, e.shiftKey);
          walk = next.walk;
          w.cycle(walk.step, [...walk.order]);
        });
      }
      if (!mod || e.altKey) return;
      if (e.shiftKey && e.key === "Enter") return run(() => w.toggleMaximise(target()));
      if (!e.shiftKey && key === "\\") return run(() => w.moveToOtherSide(target()));
      if (!e.shiftKey && key === "w") return run(() => w.requestClose([target()]));
      if (e.shiftKey && key === "t") return run(() => w.reopenClosed());
      if (!e.shiftKey && key === "t") return run(() => w.openPicker());
      if (!e.shiftKey && key === ";") return run(() => w.openTool("side"));
      if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown")) return run(() => w.moveBy(target(), e.key === "PageUp" ? -1 : 1));
      if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) return run(() => w.jump(Number(e.code.slice(5))));
    };
    const onUp = (e: KeyboardEvent) => {
      if (walk && (e.key === "Control" || !e.ctrlKey)) {
        walk = null;
        ws.current.endCycle();
      }
    };
    const onBlur = () => {
      if (!walk) return;
      walk = null;
      ws.current.endCycle();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [ws, target]);
}
