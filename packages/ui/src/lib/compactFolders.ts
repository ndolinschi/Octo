import type { FileEntry } from "@octo/agent-client";

/**
 * Compact folders (2026-11-19, decision 98): a run of directories that each hold exactly one entry, a directory, is one tree
 * row. Inside a JVM source root the run is a package and reads `com.acme.core` (IntelliJ's compact middle packages);
 * elsewhere it reads `src/main/java` (VS Code's compact folders). Pure: the tree passes what it has loaded.
 */

/** Extra levels a row may take below its first directory; the harness caps `FileEntry.chain` at the same number. */
export const MAX_CHAIN = 32;

const JVM_LANGS = new Set(["java", "kotlin", "scala", "groovy"]);

/** `…/src/<set>/<lang>` with a JVM language: where packages start (`src/main/java`, `src/test/kotlin`). */
export function isSourceRoot(path: string): boolean {
  const parts = path.split("/");
  const n = parts.length;
  return n >= 3 && JVM_LANGS.has(parts[n - 1] ?? "") && parts[n - 3] === "src";
}

/** The path is a source root or lies below one. */
export function underSourceRoot(path: string): boolean {
  const parts = path ? path.split("/") : [];
  for (let i = 3; i <= parts.length; i++) if (isSourceRoot(parts.slice(0, i).join("/"))) return true;
  return false;
}

export type CompactRow = {
  /** Directory names, first to last. */
  segments: string[];
  /** Folder-relative path of each segment. */
  paths: string[];
  /** The last directory: the row's children, and what its actions (open, menu, reveal) act on. */
  last: string;
  separator: "." | "/";
  label: string;
};

/**
 * The row a directory entry starts. Each step down takes the directory's loaded listing when there is one (it is fresher)
 * and the entry's `chain` hint otherwise, so one listing per visible row is enough. Outside packages a source root ends the
 * row (it heads the package rows below it). A name with a dot cannot be told from a package separator, so such a row uses `/`.
 */
export function compactChain(entry: Pick<FileEntry, "name" | "path" | "chain">, listing: (path: string) => readonly FileEntry[] | undefined): CompactRow {
  const segments = [entry.name];
  const paths = [entry.path];
  const pkg = underSourceRoot(entry.path.split("/").slice(0, -1).join("/"));
  let hint: readonly string[] = entry.chain ?? [];
  let cur = entry.path;
  while (segments.length <= MAX_CHAIN && (pkg || !isSourceRoot(cur))) {
    const listed = listing(cur);
    let next: { name: string; chain: readonly string[] } | null = null;
    if (listed) {
      const only = listed.length === 1 ? listed[0] : undefined;
      if (only?.type === "dir") next = { name: only.name, chain: only.chain ?? [] };
    } else if (hint[0] !== undefined) next = { name: hint[0], chain: hint.slice(1) };
    if (!next) break;
    cur = `${cur}/${next.name}`;
    segments.push(next.name);
    paths.push(cur);
    hint = next.chain;
  }
  const separator = pkg && !segments.some((s) => s.includes(".")) ? "." : "/";
  return { segments, paths, last: cur, separator, label: segments.join(separator) };
}
