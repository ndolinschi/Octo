import { useEffect, useSyncExternalStore } from "react";

/**
 * G5: a Stop the person pressed, by project, until the harness confirms the turn ended. The composer's button and the turn's
 * live row read it, so both say "Stopping…" at once; nothing reads as stopped before the turn really ends.
 */
const since = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function markStopping(key: string, at: number = Date.now()): void {
  if (since.has(key)) return;
  since.set(key, at);
  emit();
}

export function clearStopping(key: string): void {
  if (since.delete(key)) emit();
}

/** When Stop was pressed (ms), or null; a pressed Stop ends once the turn no longer runs. */
export function stoppingSince(key: string | null | undefined, running: boolean): number | null {
  return key && running ? (since.get(key) ?? null) : null;
}

/** How long the composer waits before it says the turn is still stopping (a running command has to finish first). */
export const STILL_STOPPING_MS = 5_000;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** `stoppingSince` for a component: re-renders when a Stop is pressed or cleared, and clears it when the turn ends. */
export function useStopping(key: string | null | undefined, running: boolean): number | null {
  const at = useSyncExternalStore(subscribe, () => (key ? (since.get(key) ?? null) : null));
  useEffect(() => {
    if (key && !running) clearStopping(key);
  }, [key, running]);
  return running ? at : null;
}
