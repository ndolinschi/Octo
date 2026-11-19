import { useState } from "react";
import { navigate } from "../lib/route";
import { useApp } from "../state/app";
import { useHost } from "../state/host";
import { useProject } from "../state/project";
import { Button } from "../components/primitives/Button";
import { EmptyState } from "../components/primitives/EmptyState";
import { ErrorNotice } from "../components/shared/ErrorNotice";

const NOTICE = "mx-auto w-full max-w-measure px-6 pt-10 text-sm max-drawer:px-4";

/** P1-4: the route's project was deleted (the harness answered 404): nothing else is shown or sent to under its URL. */
export function ProjectGone() {
  // B3: the same layout as a gone session (`SessionGone`): centred, the title, one sentence, the way on.
  return (
    <div role="alert" data-project-gone className="flex h-full min-h-0 flex-col">
      <EmptyState
        title="This project no longer exists"
        actions={
          <Button size="sm" onClick={() => navigate(null)}>
            Go to Home
          </Button>
        }
      >
        It was deleted, perhaps in another window.
      </EmptyState>
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry(): Promise<void> }) {
  const { bridge, refreshProjects, projects } = useApp();
  const { projectId } = useProject();
  const device = useHost().remoteDevice !== undefined;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // A project whose saved data cannot be opened: the harness's own case (what happened, the file, what to do).
  const summary = projects?.find((p) => p.id === projectId);
  const problem = summary?.status === "unavailable" ? summary.error : undefined;
  return (
    <div role="alert" className={NOTICE}>
      {problem ? (
        <ErrorNotice fields={problem} data="project-unavailable" />
      ) : (
        <>
          <p className="text-fg">Couldn't load this project.</p>
          <p className="mt-1 text-fg-2">{message.replace(/\.$/, "")}. Octo tries again by itself; Retry tries now.</p>
        </>
      )}
      {deleteErr && <p className="mt-2 text-xs text-err">{deleteErr}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || deleting}
          onClick={async () => {
            setBusy(true);
            await onRetry();
            setBusy(false);
          }}
        >
          {busy ? "Retrying…" : "Retry"}
        </Button>
        {!device &&
          (!confirming ? (
            <Button variant="quiet" size="sm" disabled={busy || deleting} onClick={() => setConfirming(true)}>
              Delete project…
            </Button>
          ) : (
            <>
              <Button
                variant="danger"
                size="sm"
                loading={deleting}
                onClick={async () => {
                  setDeleting(true);
                  setDeleteErr(null);
                  try {
                    const { deleteProjectCleanly } = await import("../lib/deleteProject");
                    await deleteProjectCleanly(bridge, projectId);
                    const next = projects?.find((p) => p.id !== projectId);
                    navigate(next?.id ?? null);
                    await refreshProjects();
                  } catch (e) {
                    setDeleteErr(e instanceof Error ? e.message : String(e));
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? "Deleting" : "Delete project"}
              </Button>
              <Button variant="quiet" size="sm" disabled={deleting} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ))}
      </div>
    </div>
  );
}
