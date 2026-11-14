/**
 * retest3 G2: what the conversation asks the Changes tab to show — one turn ("Review changes") and, optionally, one of its files
 * ("Open diff"). The chat sets it before opening the tab; the Changes pane reads it (`ChangesView`'s `focusTurn` and selection).
 * A tiny store, so the two features meet without importing each other.
 */
export type ChangesFocus = { turnId: number; folder?: string; path?: string; seq: number };

let current: ChangesFocus | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function requestChangesFocus(focus: Omit<ChangesFocus, "seq">): void {
  current = { ...focus, seq: ++seq };
  for (const l of listeners) l();
}

/** The latest request (null: show every turn). */
export function changesFocus(): ChangesFocus | null {
  return current;
}

export function clearChangesFocus(): void {
  if (current === null) return;
  current = null;
  for (const l of listeners) l();
}

/** For `useSyncExternalStore`. */
export function subscribeChangesFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
