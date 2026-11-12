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

/** A path under the user's home as `~/…` ("/Users/maya/code/atlas" → "~/code/atlas"); the home is read off the path (macOS, Linux, Windows). */
export function tildePath(path: string): string {
  const m = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/.exec(path);
  return m ? `~${path.slice(m[0].length)}` : path;
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

/** What the system folder dialog answered, as the picker acts on it. */
export type BrowseOutcome = { kind: "chosen"; path: string } | { kind: "cancelled" } | { kind: "error"; message: string };

/** The host's dialog answers a path or null (cancelled); the harness's answers `PickFolderResult`. A failure to open is a message, not a cancel. */
export function browseOutcome(result: string | null | { path?: string; cancelled?: boolean; error?: string; message?: string }): BrowseOutcome {
  if (result === null) return { kind: "cancelled" };
  if (typeof result === "string") return result.trim() ? { kind: "chosen", path: result } : { kind: "cancelled" };
  if (result.path?.trim()) return { kind: "chosen", path: result.path };
  if (result.error || (result.message && !result.cancelled)) return { kind: "error", message: result.message || "The folder dialog could not be opened." };
  return { kind: "cancelled" };
}

/** The "Browse…" row in each state: idle, waiting for the system dialog (busy, not pressable twice), and after a failure (a message under it). */
export function browseRow(
  state: { busy: boolean; error: string | null },
  shortcut: string,
): { label: string; hint: string; busy: boolean; disabled: boolean; error: string | null } {
  return {
    label: state.busy ? "Waiting for the folder dialog…" : "Browse…",
    hint: state.busy ? "" : shortcut,
    busy: state.busy,
    disabled: state.busy,
    error: state.busy ? null : state.error,
  };
}

/** The label of each folder: its own name, with the parent's name added when two chosen folders share one ("app (web)"). */
export function folderLabels(paths: readonly string[]): string[] {
  const names = paths.map(folderName);
  return paths.map((p, i) => {
    const same = names.filter((n) => n === names[i]).length > 1;
    const parent = folderName(parentOf(p));
    return same && parent ? `${names[i]} (${parent})` : (names[i] ?? "");
  });
}
