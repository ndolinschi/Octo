import { useCallback, useMemo, useState } from "react";
import { reviewApi } from "../../lib/review/api";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { toolTab } from "../../state/workspace/layout";
import { isString, slot } from "../../state/workspace/tabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Notice } from "./parts";
import { PullList } from "./PullList";
import type { ReviewMonaco } from "./ReviewDiff";
import { ReviewView } from "./ReviewView";

const TAB = toolTab("review");
/** The review open in this tab; kept when the tab moves between groups. */
const OPEN_REVIEW = slot("review-open", isString);

/**
 * The Review tab (RV2): the list of pull requests to pick from, and the review once one is open. Monaco comes from the
 * dock (`loadMonaco`), because only the files feature may import it.
 */
export function ReviewTab({ loadMonaco }: { loadMonaco(): Promise<ReviewMonaco> }) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const api = useMemo(() => reviewApi(bridge, projectId), [bridge, projectId]);
  if (!api)
    return (
      <Notice title="This harness cannot review pull requests">
        Update the harness, or open the app with the demo data (?demo=1) to try the review screens.
      </Notice>
    );
  return <Live api={api} loadMonaco={loadMonaco} />;
}

function Live({ api, loadMonaco }: { api: NonNullable<ReturnType<typeof reviewApi>>; loadMonaco(): Promise<ReviewMonaco> }) {
  const { theme } = useApp();
  const { project } = useProject();
  const ws = useWorkspace();
  const [openId, setOpenId] = useState<string | null>(() => ws.memory.get(TAB, OPEN_REVIEW) ?? null);
  const setOpen = useCallback(
    (id: string | null) => {
      ws.memory.set(TAB, OPEN_REVIEW, id ?? "");
      setOpenId(id);
    },
    [ws.memory],
  );
  const id = openId || null;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel" data-review-tab>
      {id ? (
        <ReviewView key={id} api={api} reviewId={id} theme={theme} loadMonaco={loadMonaco} onBack={() => setOpen(null)} />
      ) : (
        <PullList api={api} folders={project?.folders ?? []} onOpen={setOpen} />
      )}
    </div>
  );
}
