import type { MemoryFile } from "@octo/agent-client";

/** Most recently written first. */
export function sortFiles<T extends Pick<MemoryFile, "path" | "updated_at">>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.path.localeCompare(b.path));
}

/** 512 B, 2.4 kB, 64 kB (1 kB is 1024 bytes, as the harness's limit counts). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const k = n / 1024;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)} KB`;
}

/** The harness's limit for one memory file. */
export const FILE_LIMIT_BYTES = 64 * 1024;

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The editor's problem with a draft, or null: too large for the harness (it answers 400 otherwise). */
export function draftProblem(content: string): string | null {
  const n = byteLength(content);
  return n > FILE_LIMIT_BYTES ? `Too large: ${formatBytes(n)} of at most ${formatBytes(FILE_LIMIT_BYTES)}` : null;
}

/** The directory part of a memory path ("notes/arch.md" gives "notes/"), or "". */
export function fileDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
