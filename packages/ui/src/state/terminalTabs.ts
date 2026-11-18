import { useSyncExternalStore } from "react";

export type TerminalTabMeta = { shell: string; folder: string; title: string };

const EMPTY: TerminalTabMeta = { shell: "", folder: "", title: "" };
const state = new Map<string, TerminalTabMeta>();
const revs = new Map<string, number>();
const subs = new Map<string, Set<() => void>>();
const closeListeners = new Set<(projectId: string, terminalId: string) => void>();

function bump(pid: string) {
  revs.set(pid, (revs.get(pid) ?? 0) + 1);
  subs.get(pid)?.forEach((fn) => fn());
}

/** The name a terminal tab shows: its own title, else its shell and folder ("zsh · proj"). */
export function terminalTabName(t: TerminalTabMeta): string {
  const custom = t.title.trim();
  if (custom) return custom;
  const shell = t.shell.trim() || "Terminal";
  const folder = t.folder.trim();
  return folder ? `${shell} · ${folder}` : shell;
}

/**
 * Item 15: tabs that would share a name are numbered in the order they were opened — the first keeps its name, the next ones
 * get 2, 3, … Returns the number of each tab that needs one.
 */
export function terminalOrdinals(tabs: readonly { id: string; name: string }[]): Map<string, number> {
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  for (const t of tabs) {
    const n = (seen.get(t.name) ?? 0) + 1;
    seen.set(t.name, n);
    if (n > 1) out.set(t.id, n);
  }
  return out;
}

/** A terminal tab's metadata, with its number when another tab opened before it has the same name (`terminalOrdinals`). */
export function getTerminalTabState(pid: string, id: string): TerminalTabMeta & { ordinal?: number } {
  const own = state.get(`${pid}:${id}`);
  if (!own) return EMPTY;
  const prefix = `${pid}:`;
  // The map keeps insertion order: the order the project's terminals were opened.
  const tabs = [...state].filter(([k]) => k.startsWith(prefix)).map(([k, t]) => ({ id: k.slice(prefix.length), name: terminalTabName(t) }));
  const ordinal = terminalOrdinals(tabs).get(id);
  return ordinal === undefined ? own : { ...own, ordinal };
}

export function updateTerminalTabState(pid: string, id: string, patch: Partial<TerminalTabMeta>): void {
  const k = `${pid}:${id}`;
  const prev = state.get(k) ?? EMPTY;
  const next = { ...prev, ...patch };
  if (prev.shell === next.shell && prev.folder === next.folder && prev.title === next.title) return;
  state.set(k, next);
  bump(pid);
}

export function closeTerminalTab(pid: string, id: string): void {
  if (state.delete(`${pid}:${id}`)) bump(pid);
  closeListeners.forEach((fn) => fn(pid, id));
}

export function onTerminalTabClosed(fn: (projectId: string, terminalId: string) => void): () => void {
  closeListeners.add(fn);
  return () => void closeListeners.delete(fn);
}

export function useTerminalTabsRevision(pid: string): number {
  return useSyncExternalStore(
    (cb) => {
      let set = subs.get(pid);
      if (!set) subs.set(pid, (set = new Set()));
      set.add(cb);
      return () => void set.delete(cb);
    },
    () => revs.get(pid) ?? 0,
  );
}
