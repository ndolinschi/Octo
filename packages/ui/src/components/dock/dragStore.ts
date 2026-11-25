import { useSyncExternalStore } from "react";
import type { TabId } from "../../state/workspace/layout";
import { TAB_GAP } from "../../state/workspace/tabStrip";
import type { DropTarget } from "../../state/workspace/WorkspaceProvider";

/*
 * Decision 25 — dragging a tab, the pointer part (the maths is `state/workspace/tabStrip.ts`). This module owns the
 * dock's `data-*` drag protocol: `[data-dock-group]`, `[data-strip]`, `[data-tab-list]`, `[data-tab-wrapper]`
 * (`data-pinned` on the Orchestrator tab) and `[data-dock-body]`.
 */

export type Rect = { left: number; top: number; width: number; height: number };

export type DragState = {
  tab: TabId;
  label: string;
  x: number;
  y: number;
  /** The tab's own group and slot, and its width (the step neighbours slide by is width + gap). */
  fromGroup: string;
  fromIndex: number;
  width: number;
  /** Inside its own strip (not pulled more than 24px off it): the tab itself follows the pointer, offset by `dx`. */
  attached: boolean;
  dx: number;
  /** A strip the tab would land in, with the index among that strip's other tabs: neighbours make room there. */
  slot: { group: string; index: number } | null;
  target: DropTarget | null;
  /** A zone over a group body (split left / right, or "move here"). Strips show the gap instead (no bar). */
  indicator: Rect | null;
} | null;

/* A tiny external store, so pointer moves re-render only the strips and the drag layer. */
let current: DragState = null;
const listeners = new Set<() => void>();
export const setDrag = (next: DragState) => {
  current = next;
  for (const l of listeners) l();
};
export const getDrag = () => current;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useDrag(): DragState {
  return useSyncExternalStore(subscribe, () => current);
}

/** Boolean selector so containers (Dock) re-render only on drag start/end, not every pointermove. */
export function useIsDragging(): boolean {
  return useSyncExternalStore(subscribe, () => current !== null);
}

/** After a drop or a cancel, where the dragged tab was drawn, so its strip can let it settle into its slot. */
let settle: { tab: TabId; left: number; ms: number } | null = null;
export const setSettle = (s: { tab: TabId; left: number; ms: number }) => {
  settle = s;
};
export function takeSettle(tab: TabId): { left: number; ms: number } | null {
  if (settle?.tab !== tab) return null;
  const s = settle;
  settle = null;
  return s;
}

/** The step a neighbour slides by while `drag` makes room in a strip. */
export const dragStep = (drag: NonNullable<DragState>) => drag.width + TAB_GAP;
