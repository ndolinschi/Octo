import { useSyncExternalStore } from "react";
import type { TabId } from "../../state/workspace/layout";
import type { DropTarget, WorkspaceValue } from "../../state/workspace/WorkspaceProvider";

export type Rect = { left: number; top: number; width: number; height: number };

export type DragState = {
  tab: TabId;
  label: string;
  x: number;
  y: number;
  target: DropTarget | null;
  /** Where the drop indicator is drawn: a 2px insertion bar in a strip, or a zone over a group body. */
  indicator: (Rect & { shape: "bar" | "zone" }) | null;
} | null;

/* A tiny external store, so pointer moves re-render only the drag layer and the dragged tab. */
let current: DragState = null;
const listeners = new Set<() => void>();
const set = (next: DragState) => {
  current = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useDrag(): DragState {
  return useSyncExternalStore(subscribe, () => current);
}

/** Movement before a press on a tab becomes a drag. */
const THRESHOLD = 4;
/** Inset of a drop zone inside the group body. */
const INSET = 6;
/** Share of a group body's width, on either side, that means "split here". */
const EDGE = 0.25;

function hitTest(ws: WorkspaceValue, tab: TabId, x: number, y: number): { target: DropTarget; indicator: NonNullable<DragState>["indicator"] } | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-dock-group]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const group = el.dataset.dockGroup!;
    const strip = el.querySelector<HTMLElement>("[data-strip]");
    const sr = strip?.getBoundingClientRect();
    if (strip && sr && y <= sr.bottom) {
      const tabs = [...strip.querySelectorAll<HTMLElement>("[data-tab-wrapper]")];
      let index = tabs.findIndex((t) => {
        const tr = t.getBoundingClientRect();
        return x < tr.left + tr.width / 2;
      });
      if (index < 0) index = tabs.length;
      const ref = tabs[index] ?? tabs[tabs.length - 1];
      const rr = ref?.getBoundingClientRect();
      const barX = rr ? (index < tabs.length ? rr.left - 2 : rr.right + 1) : sr.left + 8;
      const target: DropTarget = { kind: "strip", group, index };
      if (!ws.canDrop(tab, target)) return null;
      return {
        target,
        indicator: { shape: "bar", left: Math.max(sr.left + 2, Math.min(sr.right - 4, barX)), top: sr.top + 8, width: 2, height: sr.height - 16 },
      };
    }
    const body = el.querySelector<HTMLElement>("[data-dock-body]")?.getBoundingClientRect();
    if (!body) return null;
    const rel = (x - body.left) / body.width;
    const side = rel < EDGE ? "left" : rel > 1 - EDGE ? "right" : null;
    const half = (body.width - INSET * 3) / 2;
    if (side) {
      const target: DropTarget = { kind: "split", group, side };
      if (ws.canDrop(tab, target)) {
        return {
          target,
          indicator: {
            shape: "zone",
            left: side === "left" ? body.left + INSET : body.left + INSET * 2 + half,
            top: body.top + INSET,
            width: half,
            height: body.height - INSET * 2,
          },
        };
      }
    }
    const into: DropTarget = { kind: "into", group };
    if (!ws.canDrop(tab, into)) return null;
    return {
      target: into,
      indicator: { shape: "zone", left: body.left + INSET, top: body.top + INSET, width: body.width - INSET * 2, height: body.height - INSET * 2 },
    };
  }
  return null;
}

/**
 * Starts tracking a press on a tab. Nothing changes on screen until the pointer moves past the
 * threshold; then a chip follows the pointer and the drop indicator tracks the target. Releasing
 * drops; Esc, losing the pointer or releasing over nothing cancels.
 */
export function pressTab(e: React.PointerEvent, ws: WorkspaceValue, tab: TabId, label: string) {
  if (e.button !== 0 || ws.narrow) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  let dragging = false;
  const body = document.body.style;

  const update = (x: number, y: number) => {
    const hit = hitTest(ws, tab, x, y);
    set({ tab, label, x, y, target: hit?.target ?? null, indicator: hit?.indicator ?? null });
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      dragging = true;
      body.cursor = "grabbing";
      body.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    ev.preventDefault();
    update(ev.clientX, ev.clientY);
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    body.cursor = "";
    body.userSelect = "";
    const target = current?.target;
    set(null);
    if (drop && dragging && target) ws.drop(tab, target);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) end(true);
  };
  const cancel = () => end(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
