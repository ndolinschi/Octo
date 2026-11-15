import type { RewindReport } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { errorCode, errorMessage } from "../../lib/format";
import { rewoundLabel } from "../../lib/compact";
import { ACP_RESET_NOTE, conflictReason, cutSummary, filesSummary, rewindError } from "../../lib/rewind";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Spinner } from "../primitives/Status";

/** Rows of files listed before "and N more". */
const LISTED = 8;

type Phase = { kind: "loading" } | { kind: "ready"; report: RewindReport } | { kind: "error"; message: string };

/**
 * Parity B5, decision 62; R2 checkpoints: "Restore to here". The dialog is the preview: a dry run first, what will be restored
 * or deleted (paths only: the harness reports no contents), how much of the conversation goes, and the files that block it
 * (changed outside Octo since the agent's last edit). Nothing is touched until "Restore";
 * if a file changed meanwhile the harness refuses (409 `rewind_conflict`) and the dialog reads the report again.
 */
export function RewindDialog(props: {
  messageId: number;
  /** `next`: restoring to the end of a reply cuts the request after it; `this`: `/rewind` cuts the newest request. */
  which?: "next" | "this";
  onClose(): void;
  onDone(report: RewindReport): void;
}) {
  const { bridge } = useApp();
  const { projectId, applyRewind } = useProject();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const { messageId } = props;

  useEffect(() => {
    let alive = true;
    bridge.rewind?.(projectId, { message_id: messageId, dry_run: true }).then(
      (report) => alive && setPhase({ kind: "ready", report }),
      (e: unknown) =>
        alive &&
        setPhase({
          kind: "error",
          message: rewindError(errorCode(e)) ?? `Could not check what would change: ${errorMessage(e).replace(/\.$/, "")}. Close this and try again.`,
        }),
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, messageId]);

  const confirm = async () => {
    if (!bridge.rewind || busy) return;
    setBusy(true);
    try {
      const report = await bridge.rewind(projectId, { message_id: messageId });
      applyRewind(messageId, rewoundLabel(report.acp_session_reset));
      props.onDone(report);
    } catch (e) {
      if (errorCode(e) === "rewind_conflict") {
        // A file changed since the dry run: read the report again, which now lists the conflicts.
        const report = await bridge.rewind(projectId, { message_id: messageId, dry_run: true }).catch(() => null);
        setPhase(report ? { kind: "ready", report } : { kind: "error", message: "A file changed since this was checked. Close this and try again." });
      } else {
        setPhase({
          kind: "error",
          message: rewindError(errorCode(e)) ?? `Could not restore: ${errorMessage(e).replace(/\.$/, "")}. Close this and try again.`,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const report = phase.kind === "ready" ? phase.report : null;
  const blocked = report !== null && report.conflicts.length > 0;
  return (
    <Dialog
      width="sm"
      title="Restore to this point?"
      description="Files go back to how they were at this point, and everything after it is removed. Nothing changes until you press Restore."
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant="primary" disabled={report === null || blocked || busy} onClick={() => void confirm()} aria-busy={busy}>
            {busy && <Spinner size={12} className="text-current" />}
            Restore
          </Button>
        </>
      }
    >
      <div data-rewind className="flex flex-col gap-3 text-sm">
        {phase.kind === "loading" && (
          <p className="flex items-center gap-2 text-fg-3">
            <Spinner /> Checking what would change…
          </p>
        )}
        {phase.kind === "error" && (
          <p role="alert" className="text-err">
            {phase.message}
          </p>
        )}
        {report && (
          <>
            <p className="text-fg-2">
              {cutSummary(report, props.which ?? "next")} {filesSummary(report)}
            </p>
            {report.files.length > 0 && !blocked && (
              <ul className="flex flex-col font-mono text-xs" aria-label="Files">
                {report.files.slice(0, LISTED).map((f) => (
                  <li key={`${f.folder}/${f.path}`} className="flex h-row items-center gap-2">
                    <span className="w-14 shrink-0 font-sans text-fg-3">{f.action === "delete" ? "Delete" : "Restore"}</span>
                    <span className="min-w-0 truncate text-fg" title={`${f.folder}/${f.path}`}>
                      {f.path}
                    </span>
                  </li>
                ))}
                {report.files.length > LISTED && <li className="font-sans text-fg-3">and {report.files.length - LISTED} more</li>}
              </ul>
            )}
            {blocked && (
              <div role="alert" data-rewind-conflicts className="flex flex-col gap-1.5">
                <p className="text-err">Nothing was changed. These files block the restore:</p>
                <ul className="flex flex-col">
                  {report.conflicts.map((c) => (
                    <li key={`${c.folder}/${c.path}`} className="min-w-0">
                      <span className="font-mono text-xs [overflow-wrap:anywhere] text-fg" title={`${c.folder}/${c.path}`}>
                        {c.path}
                      </span>
                      <span className="text-fg-3"> · {conflictReason(c.reason)}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-fg-3">Save or undo those changes yourself, then restore again.</p>
              </div>
            )}
            {report.acp_session_reset && !blocked && <p className="text-fg-3">{ACP_RESET_NOTE}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}
