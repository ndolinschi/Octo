import { Check, FileDiff } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { requestChangesFocus } from "../../lib/changesFocus";
import { filesChanged, rowKey } from "../../lib/v7/changes";
import { useApp } from "../../state/app";
import { keepAllFiles, keptChangesSnapshot, subscribeKeptChanges } from "../../state/keptChanges";
import { useProject } from "../../state/project";
import { loadTurnChanges, turnChangesEntry } from "../../state/turnChanges";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

/**
 * Sticky Cursor-style review bar directly above the composer when the latest turn has unreviewed file changes:
 * shows file count, `+a −r` totals, top filenames, "Review" (opens the Changes tab on that turn), and "Keep"
 * (marks the turn's files reviewed/kept and dismisses the bar). Lazy-loaded so it adds nothing to the entry bundle.
 */
export const PendingChangesBar = memo(function PendingChangesBar() {
  const { bridge } = useApp();
  const { projectId, onEvent, reload } = useProject();
  const ws = useOptionalWorkspace();
  const entry = useMemo(() => turnChangesEntry(bridge, projectId), [bridge, projectId]);
  const subscribeEntry = useCallback(
    (l: () => void) => {
      entry.listeners.add(l);
      return () => entry.listeners.delete(l);
    },
    [entry],
  );
  const turns = useSyncExternalStore(subscribeEntry, () => entry.data);
  const kept = useSyncExternalStore(subscribeKeptChanges, () => keptChangesSnapshot(projectId));

  useEffect(() => void loadTurnChanges(bridge, projectId, entry, reload), [bridge, projectId, entry, reload]);
  useEffect(
    () =>
      onEvent((ev) => {
        if (ev.type !== "change.recorded" && ev.type !== "turn.finished") return;
        entry.stale = true;
        void loadTurnChanges(bridge, projectId, entry);
      }),
    [onEvent, bridge, projectId, entry],
  );

  // `listChanges` returns turns newest first. Show the bar only when the newest turn has files not yet kept.
  const latest = turns?.[0] ?? null;
  if (!latest || latest.files.length === 0) return null;
  const keys = latest.files.map((f) => rowKey(latest.turn_id, f));
  const firstIdx = keys.findIndex((k) => !kept.has(k));
  if (firstIdx < 0) return null;

  const canReview = Boolean(ws && ws.toolEnabled("changes"));
  const preview = latest.files.slice(0, 2).map((f) => basename(f.path));
  const extra = latest.files.length - preview.length;
  const firstUnkept = latest.files[firstIdx];

  return (
    <div
      data-pending-changes-bar
      role="region"
      aria-label="Unreviewed file changes"
      className="mb-1.5 flex h-ctl-md items-center gap-2 rounded-lg border border-line bg-raised px-3 text-xs text-fg-2"
    >
      <Glyph icon={FileDiff} size={14} className="shrink-0 text-fg-3" />
      <span className="shrink-0 font-medium text-fg">{filesChanged(latest.files.length)}</span>
      <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
        {(latest.added > 0 || latest.removed === 0) && <span className="text-ok">+{latest.added}</span>}
        {latest.removed > 0 && <span className="text-err">−{latest.removed}</span>}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-fg-3 @max-[520px]/conv:hidden">
        {preview.join(" · ")}
        {extra > 0 ? ` +${extra}` : ""}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {canReview && (
          <Button
            variant="quiet"
            size="xs"
            data-warm="tool:changes"
            onClick={() => {
              requestChangesFocus({
                turnId: latest.turn_id,
                ...(firstUnkept ? { folder: firstUnkept.folder, path: firstUnkept.path } : {}),
              });
              ws?.openTool("changes");
            }}
          >
            Review
          </Button>
        )}
        <Button variant="secondary" size="xs" icon={Check} title="Mark these changes reviewed and keep them" onClick={() => keepAllFiles(projectId, keys)}>
          Keep
        </Button>
      </span>
    </div>
  );
});
