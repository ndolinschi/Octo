import { useSyncExternalStore } from "react";
import type { DesignNote } from "../lib/browser/designNotes";

const EMPTY: readonly DesignNote[] = [];
const staged = new Map<string, readonly DesignNote[]>();
const listeners = new Map<string, Set<() => void>>();

const emit = (pid: string) => listeners.get(pid)?.forEach((fn) => fn());

function subscribe(pid: string, cb: () => void): () => void {
  let set = listeners.get(pid);
  if (!set) listeners.set(pid, (set = new Set()));
  set.add(cb);
  return () => void set.delete(cb);
}

export const getStagedDesignNotes = (pid: string): readonly DesignNote[] => staged.get(pid) ?? EMPTY;

export function setStagedDesignNotes(pid: string, next: readonly DesignNote[]): void {
  if (next.length === 0) {
    if (!staged.delete(pid)) return;
  } else {
    staged.set(pid, next);
  }
  emit(pid);
}

export function stageDesignNotes(pid: string, notes: readonly DesignNote[]): void {
  if (!notes.length) return;
  const byId = new Map(getStagedDesignNotes(pid).map((n) => [n.id, n]));
  for (const n of notes) byId.set(n.id, n);
  setStagedDesignNotes(pid, [...byId.values()]);
}

export const removeStagedDesignNote = (pid: string, id: string): void =>
  setStagedDesignNotes(
    pid,
    getStagedDesignNotes(pid).filter((n) => n.id !== id),
  );

export const clearStagedDesignNotes = (pid: string): void => setStagedDesignNotes(pid, EMPTY);

export const useStagedDesignNotes = (pid: string): readonly DesignNote[] =>
  useSyncExternalStore(
    (cb) => subscribe(pid, cb),
    () => getStagedDesignNotes(pid),
  );

export const useStagedDesignNotesCount = (pid: string): number =>
  useSyncExternalStore(
    (cb) => subscribe(pid, cb),
    () => getStagedDesignNotes(pid).length,
  );
