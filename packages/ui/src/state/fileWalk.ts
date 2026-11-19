import type { FileEntry } from "@octo/agent-client";

/** The limits of `CodeProvider`'s file index (contract v6 decision 6). */
const INDEX_MAX_DIRS = 200;
const INDEX_MAX_ENTRIES = 5000;

/**
 * Decision 99: the walk of `CodeProvider`'s file index, for `projectPreload` (a project read before it is shown, so file links
 * in its prose are links in the first frame). One level at a time, the directories of a level side by side (its time is the
 * tree's depth, not its size). `list` gives a directory's entries (null: unreadable, skipped).
 */
export async function walkFolders(folders: readonly string[], list: (folder: string, path: string) => Promise<FileEntry[] | null>): Promise<void> {
  let level: [string, string][] = folders.map((f) => [f, ""]);
  let seenDirs = 0;
  let seenEntries = 0;
  while (level.length > 0 && seenDirs < INDEX_MAX_DIRS && seenEntries < INDEX_MAX_ENTRIES) {
    const batch = level.slice(0, INDEX_MAX_DIRS - seenDirs);
    seenDirs += batch.length;
    const read = await Promise.all(batch.map(([folder, path]) => list(folder, path)));
    level = [];
    read.forEach((entries, i) => {
      const folder = batch[i]?.[0] ?? "";
      seenEntries += entries?.length ?? 0;
      for (const e of entries ?? []) if (e.type === "dir") level.push([folder, e.path]);
    });
  }
}
