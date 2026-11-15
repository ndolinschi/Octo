import type { ChangeDetail, ChangeKind, ChangeNote, ChangeSource, FileChangeSummary, TurnChanges } from "@octo/agent-client";
import { formatSeparator } from "../format";

/**
 * The changes view (v7 §1, decision 47): per-turn file rows, net diffs, the revert order and its 409s, the diff layout.
 * Pure; no Monaco, no React.
 */

/** Side by side at this window width and up (and when the pane itself has room), else one column. */
export const DIFF_SPLIT_MIN = 1100;
export const DIFF_SPLIT_PANE_MIN = 720;
/** Decision 46: changed lines flash their tone for 600 ms and fade. */
export const DIFF_FLASH_MS = 600;

export type DiffLayout = "split" | "unified";

export function diffLayout(windowWidth: number, paneWidth: number): DiffLayout {
  return windowWidth >= DIFF_SPLIT_MIN && paneWidth >= DIFF_SPLIT_PANE_MIN ? "split" : "unified";
}

/** Who made a change, in three words the row can show: a built-in tool, a shell command, or an ACP agent. */
export function sourceLabel(source: ChangeSource): "tool" | "bash" | "agent" {
  switch (source) {
    case "write_file":
      return "tool";
    case "bash":
      return "bash";
    case "acp_fs":
    case "acp_turn":
      return "agent";
  }
}

export function kindLabel(kind: ChangeKind): string {
  return kind === "created" ? "Added" : kind === "deleted" ? "Deleted" : "Modified";
}

/** One letter for the row's kind badge (A / M / D). */
export function kindLetter(kind: ChangeKind): "A" | "M" | "D" {
  return kind === "created" ? "A" : kind === "deleted" ? "D" : "M";
}

/** Why a change shows no diff, as the pane says it; null when there is one. */
export function noteText(note: ChangeNote): string | null {
  switch (note) {
    case "binary":
      return "Binary file: no text diff.";
    case "too_large":
      return "Too large to diff (over 2 MB).";
    case "no_preimage":
      return "The content before this change was not kept, so there is no diff.";
    case "pruned":
      return "Older than 30 days: the diff was removed.";
    case "":
      return null;
  }
}

/** A stable key for a file row (folder label + path; never the file-key separator). */
export function rowKey(turnId: number, file: Pick<FileChangeSummary, "folder" | "path">): string {
  return `${turnId}:${file.folder}/${file.path}`;
}

/** Folder part and name of a path, for "name  muted/folder". */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

export function formatCount(n: number | null, sign: "+" | "−"): string {
  return n === null ? "" : `${sign}${n}`;
}

/**
 * A file's net change in a turn spans several recorded changes: reverting it means reverting them newest first (each
 * revert checks the file still equals that change's after). Ids are numeric and grow with time.
 */
export function revertOrder(file: Pick<FileChangeSummary, "change_ids">): number[] {
  return [...file.change_ids].sort((a, b) => b - a);
}

/** Every change of a turn, newest first across its files. */
export function turnRevertOrder(turn: { files: readonly Pick<FileChangeSummary, "change_ids">[] }): number[] {
  return turn.files.flatMap((f) => f.change_ids).sort((a, b) => b - a);
}

/** The ids needed for the net diff: the first change (its before) and the last (its after); one id when they agree. */
export function netIds(file: Pick<FileChangeSummary, "change_ids">): { first: number; last: number } | null {
  if (!file.change_ids.length) return null;
  const sorted = [...file.change_ids].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === undefined || last === undefined ? null : { first, last };
}

export type NetDiff = { before: string; after: string } | { unavailable: string };

/** First before → last after; a created file diffs against nothing, a deleted one to nothing. */
export function netDiff(file: Pick<FileChangeSummary, "kind" | "note">, first: ChangeDetail, last: ChangeDetail): NetDiff {
  const why = noteText(file.note) ?? noteText(first.note) ?? noteText(last.note);
  if (!first.diff_available || !last.diff_available) return { unavailable: why ?? "No diff is available for this change." };
  const before = file.kind === "created" ? "" : first.before;
  const after = file.kind === "deleted" ? "" : last.after;
  if (before === null || after === null) return { unavailable: why ?? "No diff is available for this change." };
  return { before, after };
}

export type RevertProblem = { kind: "file_changed" | "revert_unavailable" | "not_found" | "other"; message: string };

function codeOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null || !("code" in e)) return null;
  return typeof e.code === "string" ? e.code : null;
}

/** A failed revert in the pane's words, each with the next step. */
export function revertProblem(e: unknown): RevertProblem {
  switch (codeOf(e)) {
    case "file_changed":
      return {
        kind: "file_changed",
        message: "The file changed after this request, so it was not reverted. Open the file to undo the edit by hand.",
      };
    case "revert_unavailable":
      return {
        kind: "revert_unavailable",
        message: "The content before this change was not kept, so it cannot be reverted. Open the file to undo it by hand.",
      };
    case "not_found":
      return { kind: "not_found", message: "This change is gone. Refresh the list." };
    default:
      return { kind: "other", message: `${e instanceof Error ? e.message : String(e)}. Try again.` };
  }
}

/** Neighbouring files across the turn for prev / next; wraps nowhere. */
export function neighbours<T>(items: readonly T[], index: number): { prev: T | null; next: T | null } {
  return { prev: index > 0 ? (items[index - 1] ?? null) : null, next: items[index + 1] ?? null };
}

/** "3 files changed", "1 file changed". */
export function filesChanged(n: number): string {
  return `${n} file${n === 1 ? "" : "s"} changed`;
}

/**
 * The heading of a turn whose request is not among the loaded messages: "Earlier request · Yesterday 18:42" with the time of
 * its first recorded change, "Earlier request" without one — never the turn's internal id.
 */
export function earlierRequestLabel(turn: Pick<TurnChanges, "files">, now: number): string {
  const first = turn.files
    .map((f) => f.created_at)
    .filter((at) => !Number.isNaN(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return first ? `Earlier request · ${formatSeparator(first, now)}` : "Earlier request";
}
