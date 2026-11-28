import { Check, FileDiff } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { requestChangesFocus } from "../../lib/changesFocus";
import { filesChanged } from "../../lib/v7/changes";
import { useApp } from "../../state/app";
import { keepAllFiles, keptChangesSnapshot, subscribeKeptChanges } from "../../state/keptChanges";
import { useProject } from "../../state/project";
import { loadTurnChanges, turnChangesEntry } from "../../state/turnChanges";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { summarizePendingChanges } from "./pendingChanges";

/**
 * Sticky review bar directly above `.octo-composer` when the latest turn has unreviewed file changes:
 * shows file count, `+a −r` totals, top filenames, "Review" (opens the Changes tab on that turn), and "Keep"
 * (marks the turn's files reviewed/kept and dismisses the bar). Matches `.octo-composer`'s `12px` radius and
 * hairline outline with `36px` (`h-strip`) height and concentric `6px` insets around the `24px` action buttons.
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
  const summary = useMemo(() => summarizePendingChanges(turns, kept), [turns, kept]);
  if (!summary) return null;

  const canReview = Boolean(ws?.toolEnabled("changes"));

  return (
    <div
      data-pending-changes-bar
      role="region"
      aria-label="Unreviewed file changes"
      className="mb-2 flex min-h-strip items-center gap-2 rounded-xl bg-raised pr-1.5 pl-3 text-xs text-fg-2 outline-1 -outline-offset-1 outline-line phone:h-auto phone:py-1"
    >
      <Glyph icon={FileDiff} size={14} className="shrink-0 text-fg-3" />
      <span className="shrink-0 font-medium text-fg">{filesChanged(summary.fileCount)}</span>
      <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
        {(summary.added > 0 || summary.removed === 0) && <span className="text-ok">+{summary.added}</span>}
        {summary.removed > 0 && <span className="text-err">−{summary.removed}</span>}
      </span>
      {summary.preview.length > 0 && (
        <>
          <span aria-hidden className="h-3 w-px shrink-0 bg-line @max-[520px]/conv:hidden" />
          <span className="min-w-0 flex-1 truncate font-mono text-fg-3 @max-[520px]/conv:hidden">
            {summary.preview.join(" · ")}
            {summary.extra > 0 ? ` +${summary.extra}` : ""}
          </span>
        </>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {canReview && (
          <Button
            variant="quiet"
            size="xs"
            data-warm="tool:changes"
            onClick={() => {
              requestChangesFocus({
                turnId: summary.turnId,
                ...(summary.firstUnkept ? { folder: summary.firstUnkept.folder, path: summary.firstUnkept.path } : {}),
              });
              ws?.openTool("changes");
            }}
          >
            Review
          </Button>
        )}
        <Button
          variant="secondary"
          size="xs"
          icon={Check}
          title="Mark these changes reviewed and keep them"
          onClick={() => keepAllFiles(projectId, summary.keys)}
        >
          Keep
        </Button>
      </span>
    </div>
  );
});
