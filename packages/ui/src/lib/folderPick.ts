import type { FolderEntry } from "@octo/agent-client";

/** Decision 49: the typed text is a path (so the harness completes it) when it starts like one: `/`, `~`, a drive letter. */
export function looksLikePath(text: string): boolean {
  return /^(\/|~|[A-Za-z]:[\\/])/.test(text.trim());
}

/** The folder that contains `path` ("/Users/maya/code/atlas" → "/Users/maya/code"); "" for a root or a bare name. */
export function parentOf(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : "";
}

/** The last segment of a path, for a row's name. */
export function folderName(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) || p : p;
}

/** Recent folders: the ones chosen here first (newest first), then the harness's, each path once, at most `max`. */
export function mergeRecent(chosen: readonly string[], harness: readonly FolderEntry[], max = 8): FolderEntry[] {
  const out: FolderEntry[] = [];
  const seen = new Set<string>();
  const add = (e: FolderEntry) => {
    const key = e.path.replace(/[\\/]+$/, "");
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(e);
  };
  for (const path of chosen) add(harness.find((h) => h.path === path) ?? { name: folderName(path), path, git: null });
  for (const e of harness) add(e);
  return out;
}

/** Remembers a chosen folder (newest first, at most 8). */
export function rememberFolder(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, 8);
}

/** The stored list of chosen folders: strings only. */
export function chosenFrom(parsed: unknown): string[] {
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 1000).slice(0, 8) : [];
}

/** `Tab` completes a directory row into the query, ready for its children: "/Users/maya/co" → "/Users/maya/code/". */
export function completion(path: string): string {
  return path.endsWith("/") || path.endsWith("\\") ? path : `${path}/`;
}
