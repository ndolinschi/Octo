import type { TabId } from "../../state/workspace/layout";
import type { WorkspaceValue } from "../../state/workspace/WorkspaceProvider";

/*
 * Decision 25 — dragging a tab. The store the strips and the drag layer read is `dragStore.ts`; the pointer tracking
 * (`dragPress.ts`, which owns the dock's `data-*` drag protocol: `[data-dock-group]`, `[data-strip]`, `[data-tab-list]`,
 * `[data-tab-wrapper]` (`data-pinned` on the Orchestrator tab) and `[data-dock-body]`) is its own chunk, warmed after
 * the first paint and loaded by the first press at the latest.
 */
export { dragStep, takeSettle, useDrag } from "./dragStore";

/**
 * Starts tracking a press on a tab: the pointer's data is read now, the tracking starts once its chunk is in. A press
 * that was released before then is not tracked (it would wait for a release that already happened).
 */
export function pressTab(e: React.PointerEvent, ws: WorkspaceValue, tab: TabId, label: string) {
  if (e.button !== 0 || ws.narrow) return;
  const wrapper = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  if (!wrapper) return;
  const press = {
    wrapper,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    touch: e.pointerType === "touch",
    pressedAt: performance.now(),
  };
  let released = false;
  const up = (ev: PointerEvent) => {
    if (ev.pointerId === press.pointerId) released = true;
  };
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  // A chunk that fails to load leaves the tab without drag; the next press tries again.
  void import("./dragPress").then(
    (m) => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      if (!released) m.trackPress(press, ws, tab, label);
    },
    () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    },
  );
}

/** Loads the pointer tracking ahead of the first press. */
export const warmDrag = () => void import("./dragPress").catch(() => undefined);
