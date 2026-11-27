import { useSyncExternalStore } from "react";

export type PickerState = { projectId: string; group: string; n: number } | null;

/**
 * Tiny external store for the "+" tab picker (modeled on `dragStore.ts`): opening or closing the picker re-renders only
 * the owning `TabStrip`, never `WorkspaceProvider` or unrelated panes.
 */
let current: PickerState = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openTabPicker(projectId: string, group: string): void {
  current = { projectId, group, n: (current?.n ?? 0) + 1 };
  emit();
}

export function closeTabPicker(projectId?: string): void {
  if (current === null) return;
  if (projectId !== undefined && current.projectId !== projectId) return;
  current = null;
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Returns the picker counter when open in `group` of `projectId`, else `null` (primitive selector: only the target strip re-renders). */
export function useTabPickerKey(projectId: string, group: string): number | null {
  return useSyncExternalStore(subscribe, () => (current !== null && current.projectId === projectId && current.group === group ? current.n : null));
}
