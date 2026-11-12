import type { ReviewFile, ReviewGroup } from "@octo/agent-client";

/** The reading order of the groups, as the harness sorts them (core first, mechanical last and folded). */
export const GROUP_ORDER: readonly ReviewGroup[] = ["core", "callers", "tests", "other", "mechanical"];

export const GROUP_LABEL: Record<ReviewGroup, string> = {
  core: "Core change",
  callers: "Callers",
  tests: "Tests",
  other: "Docs, config and assets",
  mechanical: "Mechanical",
};

/** Why a file is in its group, in words (the API's `reason`). */
const REASON: Record<string, string> = {
  lockfile: "lock file",
  generated: "generated",
  rename: "renamed only",
  formatting: "formatting only",
  docs: "docs",
  config: "config",
  asset: "asset",
  core: "core",
  caller: "caller",
  test: "test",
};

export function reasonLabel(reason: string): string {
  return REASON[reason] ?? reason;
}

export type FileSection = { group: ReviewGroup; label: string; files: ReviewFile[]; /** Collapsed until the reader opens it. */ folded: boolean };

/** Files in the API's reading order (`order`, then path so equal orders stay stable). */
export function readingOrder(files: readonly ReviewFile[]): ReviewFile[] {
  return [...files].sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
}

/** The reading-order files split into their groups; empty groups are left out. */
export function groupFiles(files: readonly ReviewFile[]): FileSection[] {
  const sorted = readingOrder(files);
  return GROUP_ORDER.flatMap((group) => {
    const inGroup = sorted.filter((f) => f.group === group);
    return inGroup.length ? [{ group, label: GROUP_LABEL[group], files: inGroup, folded: group === "mechanical" }] : [];
  });
}

/** Keeps only files that changed after the review was submitted ("changed since your review"). */
export function sinceReview(files: readonly ReviewFile[]): ReviewFile[] {
  return files.filter((f) => f.changed_since_submitted);
}

/**
 * The files `]` and `[` walk through: reading order, with the files of a folded group left out unless the reader has
 * opened that group (the selected file stays reachable either way).
 */
export function navigableFiles(sections: readonly FileSection[], opened: ReadonlySet<ReviewGroup>, selected: string | null): ReviewFile[] {
  return sections.flatMap((s) => (s.folded && !opened.has(s.group) ? s.files.filter((f) => f.path === selected) : s.files));
}

/** The file after (dir 1) or before (dir -1) `path`; none at the ends. With no file selected, the first (or last) one. */
export function stepFile(files: readonly ReviewFile[], path: string | null, dir: 1 | -1): ReviewFile | null {
  if (files.length === 0) return null;
  const at = path === null ? -1 : files.findIndex((f) => f.path === path);
  if (at < 0) return (dir === 1 ? files[0] : files[files.length - 1]) ?? null;
  return files[at + dir] ?? null;
}

const UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${i === 0 ? n : (n / 1024 ** i).toFixed(1)} ${UNITS[i]}`;
}

/** "12 KB → 14 KB", "new, 3 KB", "removed, 3 KB": a binary file's change (sizes are -1 when the side is absent). */
export function sizeChange(f: Pick<ReviewFile, "old_size" | "new_size">): string {
  if (f.old_size < 0 && f.new_size < 0) return "size unknown";
  if (f.old_size < 0) return `new, ${formatBytes(f.new_size)}`;
  if (f.new_size < 0) return `removed, ${formatBytes(f.old_size)}`;
  if (f.old_size === f.new_size) return `${formatBytes(f.new_size)}, same size`;
  return `${formatBytes(f.old_size)} → ${formatBytes(f.new_size)}`;
}

export function viewedProgress(files: readonly ReviewFile[]): { viewed: number; total: number } {
  return { viewed: files.filter((f) => f.viewed).length, total: files.length };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "14 files, +312 −88" */
export function totalsText(t: { files: number; added: number; removed: number }): string {
  return `${plural(t.files, "file")}, +${t.added} −${t.removed}`;
}

export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}
