import type { MoveToWorktreeResult, ProjectSession } from "@octo/agent-client";
import { useId, useState } from "react";
import { defaultWorktreeBranch, failureText } from "../../lib/sessions/model";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Dialog } from "../primitives/Dialog";
import { Field } from "../primitives/Field";
import { Notice } from "../primitives/Notice";
import { TextField } from "../primitives/TextField";

/**
 * Moves a main session out of the shared main checkout into its own git worktree (`moveSessionToWorktree`).
 * Lets the person adjust the branch name and decide whether uncommitted changes in the main checkout are copied into
 * the new worktree.
 */
export function MoveToWorktreeDialog(props: { projectId: string; session: ProjectSession; onClose(): void; onMoved?(result: MoveToWorktreeResult): void }) {
  const { bridge } = useApp();
  const activity = useActivity();
  const branchId = useId();
  const errId = useId();
  const [branch, setBranch] = useState(() => defaultWorktreeBranch(props.session));
  const [carryChanges, setCarryChanges] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  const title = props.session.title.trim() || "New session";

  const submit = async () => {
    if (busy) return;
    const trimmed = branch.trim();
    if (!trimmed) {
      setBranchError("Enter a branch name for the worktree.");
      return;
    }
    const move = bridge.moveSessionToWorktree;
    if (!move) {
      setError("This version of Octo's local service does not support worktrees.");
      return;
    }
    setBusy(true);
    setError(null);
    setBranchError(null);
    try {
      const result = await move(props.projectId, props.session.id, {
        branch: trimmed,
        carry_changes: carryChanges,
      });
      activity.refreshSessions();
      props.onMoved?.(result);
      props.onClose();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Move session to worktree"
      description={`Run “${title}” in its own git worktree so file edits stay isolated from the main checkout.`}
      width="sm"
      onClose={() => {
        if (!busy) props.onClose();
      }}
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {busy ? "Moving…" : "Move to worktree"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Notice tone="error">{error}</Notice>}
        <Field
          label="Branch name"
          htmlFor={branchId}
          hint="Octo creates or checks out this branch in a dedicated worktree directory for each git repository folder."
          error={branchError}
          errorId={errId}
        >
          <TextField
            id={branchId}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- opening the worktree dialog puts focus right in its branch field
            autoFocus
            value={branch}
            maxLength={120}
            disabled={busy}
            aria-invalid={branchError ? true : undefined}
            aria-describedby={branchError ? errId : undefined}
            placeholder="octo/feature-branch"
            onChange={(e) => {
              setBranch(e.target.value);
              if (branchError) setBranchError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        <Checkbox
          checked={carryChanges}
          disabled={busy}
          onChange={setCarryChanges}
          label="Carry uncommitted changes from main checkout"
          description="Applies current staged, unstaged, and untracked changes to the new worktree while keeping your main checkout intact."
        />
      </div>
    </Dialog>
  );
}
