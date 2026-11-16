import { useSyncExternalStore } from "react";
import { jsonCodec, loadPref, PREFS, writePref } from "../lib/storage";

export type BrowserViewport = "full" | "desktop" | "tablet" | "mobile";
export type BrowserTabState = { url: string; title: string; viewport: BrowserViewport; batchEdits: boolean };
type ProjectBrowserMap = Record<string, BrowserTabState>;

const VIEWPORTS: readonly BrowserViewport[] = ["full", "desktop", "tablet", "mobile"];
const DEFAULT_TAB: BrowserTabState = { url: "", title: "", viewport: "full", batchEdits: false };

const codec = jsonCodec<ProjectBrowserMap>((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProjectBrowserMap = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    out[id] = {
      url: typeof r.url === "string" ? r.url : "",
      title: typeof r.title === "string" ? r.title : "",
      viewport: VIEWPORTS.find((vp) => vp === r.viewport) ?? "full",
      batchEdits: r.batchEdits === true,
    };
  }
  return out;
});

const cache = new Map<string, ProjectBrowserMap>();
const pins = new Map<string, number>();
const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

function bump(pid: string) {
  revisions.set(pid, (revisions.get(pid) ?? 0) + 1);
  listeners.get(pid)?.forEach((fn) => fn());
}

function readMap(pid: string): ProjectBrowserMap {
  let hit = cache.get(pid);
  if (!hit) cache.set(pid, (hit = loadPref(PREFS.browserTabs(pid), codec)));
  return hit;
}

export const getBrowserTabState = (pid: string, id: string): BrowserTabState => readMap(pid)[id] ?? DEFAULT_TAB;
export const getBrowserTabPins = (pid: string, id: string): number => pins.get(`${pid}:${id}`) ?? 0;

export function updateBrowserTabState(pid: string, id: string, patch: Partial<BrowserTabState>): void {
  const cur = readMap(pid);
  const prev = cur[id] ?? DEFAULT_TAB;
  const next = { ...prev, ...patch };
  if (prev.url === next.url && prev.title === next.title && prev.viewport === next.viewport && prev.batchEdits === next.batchEdits) return;
  const updated = { ...cur, [id]: next };
  cache.set(pid, updated);
  writePref(PREFS.browserTabs(pid), codec.stringify(updated));
  bump(pid);
}

export function setBrowserTabPins(pid: string, id: string, count: number): void {
  const k = `${pid}:${id}`;
  if ((pins.get(k) ?? 0) === count) return;
  if (count <= 0) pins.delete(k);
  else pins.set(k, count);
  bump(pid);
}

export function useBrowserTabsRevision(pid: string): number {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(pid);
      if (!set) listeners.set(pid, (set = new Set()));
      set.add(cb);
      return () => void set.delete(cb);
    },
    () => revisions.get(pid) ?? 0,
  );
}

export function useBrowserTabState(pid: string, id: string): BrowserTabState {
  useBrowserTabsRevision(pid);
  return getBrowserTabState(pid, id);
}
