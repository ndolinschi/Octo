import { useCallback, useEffect, useState } from "react";
import { BridgeError, type Review, type ReviewCheckoutResult, type ReviewDirtyFile, type ReviewWorkspace } from "@octo/agent-client";
import { errorMessage } from "../../lib/format";
import type { ReviewApi } from "../../lib/review/api";
import { useProject } from "../../state/project";

/**
 * Check out (decision 78): "workspace" points the project's file tree, editor and language server at the review's read-only
 * worktree; "working copy" switches the project's own folder to the pull request's branch, after showing what is
 * uncommitted. The harness never forces git: a dirty folder comes back as a list the user confirms.
 */
export function useCheckout(api: ReviewApi, review: Review) {
  const { project, onEvent } = useProject();
  const [workspace, setWorkspace] = useState<ReviewWorkspace | null>(project?.review_workspace ?? null);
  const [switched, setSwitched] = useState<ReviewCheckoutResult | null>(null);
  const [dirty, setDirty] = useState<ReviewDirtyFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "review.workspace") setWorkspace(e.review_workspace);
      }),
    [onEvent],
  );

  const run = useCallback(
    async (mode: "workspace" | "working_copy", confirm: boolean) => {
      if (!api.checkout) return;
      setBusy(true);
      setError(null);
      try {
        const r = await api.checkout(review.id, { mode, ...(confirm ? { confirm: true } : {}) });
        setDirty(null);
        if (r.workspace) setWorkspace(r.workspace);
        if (mode === "working_copy") setSwitched(r);
      } catch (e) {
        if (e instanceof BridgeError && e.code === "dirty_working_copy" && e.files) setDirty(e.files);
        else setError(`${errorMessage(e).replace(/\.$/, "")}. Nothing was changed in your folder; resolve it in git, then try again.`);
      } finally {
        setBusy(false);
      }
    },
    [api, review.id],
  );

  const back = useCallback(async () => {
    if (!api.clearWorkspace) return;
    setBusy(true);
    setError(null);
    try {
      await api.clearWorkspace();
      setWorkspace(null);
    } catch (e) {
      setError(`${errorMessage(e).replace(/\.$/, "")}. Try again.`);
    } finally {
      setBusy(false);
    }
  }, [api]);

  return {
    available: api.checkout !== null,
    inWorkspace: workspace?.review_id === review.id,
    switched,
    dirty,
    busy,
    error,
    openWorkspace: () => run("workspace", false),
    startWorkingCopy: () => run("working_copy", false),
    confirmWorkingCopy: () => run("working_copy", true),
    closeDirty: () => setDirty(null),
    dismissSwitched: () => setSwitched(null),
    dismissError: () => setError(null),
    back,
  };
}
