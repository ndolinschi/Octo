import { useSyncExternalStore } from "react";
import { jsonCodec, loadPref, PREFS, writePref } from "./storage";

const codec = jsonCodec<readonly string[]>((raw) => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []));
const listeners = new Set<() => void>();
let value: readonly string[] | null = null;

const read = (): readonly string[] => (value ??= loadPref(PREFS.pinnedProjects, codec));

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = () => {
    value = null;
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** Pins or unpins a project by id; returns the new pinned state. */
export function togglePinnedProject(projectId: string): boolean {
  const cur = read();
  const has = cur.includes(projectId);
  const next = has ? cur.filter((id) => id !== projectId) : [projectId, ...cur];
  if (writePref(PREFS.pinnedProjects, codec.stringify(next))) {
    value = next;
    for (const fn of listeners) fn();
  }
  return !has;
}

export function usePinnedProjects(): readonly string[] {
  return useSyncExternalStore(subscribe, read);
}
