import type { ProjectSummary } from "@octo/agent-client";
import { useState } from "react";
import { deleteProjectCleanly } from "../../lib/deleteProject";
import { navigate } from "../../lib/route";
import { failureText } from "../../lib/sessions/model";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Notice } from "../primitives/Notice";

/**
 * Confirms and executes project deletion from any project list (sidebar tree, projects list, Home),
 * stopping running turns/sessions/terminals cleanly and navigating away if the deleted project was open.
 */
export function DeleteProjectDialog(props: { project: ProjectSummary; activeProjectId: string | null; onClose(): void }) {
  const { bridge, projects, refreshProjects } = useApp();
  const activity = useActivity();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProjectCleanly(bridge, props.project.id);
      if (props.project.id === props.activeProjectId) {
        const next = projects?.find((p) => p.id !== props.project.id);
        navigate(next?.id ?? null);
      }
      await refreshProjects();
      activity.refreshSessions();
      props.onClose();
    } catch (e) {
      setError(failureText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Delete ${props.project.name}?`}
      description="The project and its session history in Octo are deleted. Your files on disk stay untouched. This can't be undone."
      onClose={props.onClose}
      width="sm"
      footer={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            {busy ? "Deleting" : "Delete"}
          </Button>
        </>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}
