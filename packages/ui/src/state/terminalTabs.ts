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

/** The tab's full name, as the tab strip shows it: the title, else the shell ("Terminal" while unknown) with its folder ("zsh · proj"). */
export function terminalTabName(t?: TerminalTabMeta): string {
  const custom = t?.title.trim() ?? "";
  const folder = t?.folder.trim() ?? "";
  const label = custom || t?.shell.trim() || "Terminal";
  return !custom && folder ? `${label} · ${folder}` : label;
}

export const getTerminalTabState = (pid: string, id: string): TerminalTabMeta => state.get(`${pid}:${id}`) ?? EMPTY;

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
