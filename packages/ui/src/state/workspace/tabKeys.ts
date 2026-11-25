import type { RefObject } from "react";
import type { TabId } from "./layout";
import type { TabWalk, walkPress as WalkPress } from "./tabStrip";

/** The part of the workspace the shortcuts drive (structural, so the shortcuts do not import the provider). */
export type TabKeysApi = {
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
  openTool(tool: "side" | "terminal"): void;
  openTerminal(options?: { newTab?: boolean }): unknown;
  /** Decision 78: whole-dock mode for the group of `tab`. */
  toggleMaximise(tab: TabId, on?: boolean): void;
};

/**
 * The tab shortcuts' listeners (see `useTabKeys`): their own chunk, loaded right after the first render (entry budget). Takes
 * `walkPress` from the caller, so this chunk shares no module with the entry (a shared one would split into a chunk of its own).
 * Returns the cleanup.
 */
export function listenTabKeys(ws: RefObject<TabKeysApi>, target: () => TabId, walkPress: typeof WalkPress): () => void {
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
    if (!e.shiftKey && (key === "`" || e.code === "Backquote")) return run(() => w.openTool("terminal"));
    if (e.shiftKey && (key === "`" || key === "~" || e.code === "Backquote")) return run(() => void w.openTerminal({ newTab: true }));
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
}
