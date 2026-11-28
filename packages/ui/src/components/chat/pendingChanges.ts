import type { FileChangeSummary, TurnChanges } from "@octo/agent-client";
import { fileName } from "../../lib/files";
import { rowKey } from "../../lib/v7/changes";

export type PendingChangesSummary = {
  turnId: number;
  fileCount: number;
  added: number;
  removed: number;
  keys: readonly string[];
  preview: readonly string[];
  extra: number;
  firstUnkept: FileChangeSummary | undefined;
};

const PREVIEW_LIMIT = 2;

/**
 * Summarises the newest turn's unreviewed file changes for `PendingChangesBar`.
 * Returns `null` when there are no turns, no files on the newest turn, or every file in that turn has been kept.
 */
export function summarizePendingChanges(turns: readonly TurnChanges[] | null | undefined, kept: ReadonlySet<string>): PendingChangesSummary | null {
  const latest = turns?.[0];
  if (!latest || latest.files.length === 0) return null;
  const keys = latest.files.map((f) => rowKey(latest.turn_id, f));
  const firstIdx = keys.findIndex((k) => !kept.has(k));
  if (firstIdx < 0) return null;
  const preview = latest.files.slice(0, PREVIEW_LIMIT).map((f) => fileName(f.path));
  return {
    turnId: latest.turn_id,
    fileCount: latest.files.length,
    added: latest.added,
    removed: latest.removed,
    keys,
    preview,
    extra: latest.files.length - preview.length,
    firstUnkept: latest.files[firstIdx],
  };
}
