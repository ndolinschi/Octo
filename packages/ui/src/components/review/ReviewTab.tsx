import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReviewCommandsKit } from "../../lib/commands/kit";
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

type Loaders = { loadMonaco(): Promise<ReviewMonaco>; loadCommands(): Promise<ReviewCommandsKit> };

/**
 * The Review tab (RV2, decision 78): the picker of pull requests, and the review on the whole content area once one is open.
 * Monaco and the commands (run buttons, run panel) come from the dock as loaders: only the files feature may import Monaco,
 * and features do not import each other.
 */
export function ReviewTab(props: Loaders) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const api = useMemo(() => reviewApi(bridge, projectId), [bridge, projectId]);
  if (!api)
    return (
      <Notice title="This version of Octo's local service cannot review pull requests">
        Update the harness, or open the app with the demo data (?demo=1) to try the review screens.
      </Notice>
    );
  return <Live api={api} {...props} />;
}

function Live({ api, loadMonaco, loadCommands }: { api: NonNullable<ReturnType<typeof reviewApi>> } & Loaders) {
  const { theme } = useApp();
  const { project } = useProject();
  const ws = useWorkspace();
  const [openId, setOpenId] = useState<string | null>(() => ws.memory.get(TAB, OPEN_REVIEW) ?? null);
  // The review the person just left: the list puts focus on its row.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [kit, setKit] = useState<ReviewCommandsKit | null>(null);
  const { memory, toggleMaximise } = ws;
  // Decision 78: opening a pull request puts the review on the whole dock; "back to the list" gives the other panels back.
  // A review restored from memory (the tab moved or the project reopened) does not change the layout.
  const setOpen = useCallback(
    (id: string | null) => {
      memory.set(TAB, OPEN_REVIEW, id ?? "");
      setOpenId(id);
      toggleMaximise(TAB, id !== null);
    },
    [memory, toggleMaximise],
  );
  // The commands chunk loads beside the review; until it is in, the run buttons are simply absent (nothing jumps: they sit in a flex row).
  useEffect(() => {
    let alive = true;
    loadCommands().then(
      (k) => alive && setKit(k),
      () => undefined, // without the chunk the review still works; the run buttons stay away
    );
    return () => {
      alive = false;
    };
  }, [loadCommands]);
  const id = openId || null;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel" data-review-tab>
      {id ? (
        <ReviewView
          key={id}
          api={api}
          reviewId={id}
          theme={theme}
          commands={kit}
          loadMonaco={loadMonaco}
          onBack={() => {
            setReturnTo(id);
            setOpen(null);
          }}
        />
      ) : (
        <PullList api={api} folders={project?.folders ?? []} onOpen={setOpen} returnTo={returnTo} />
      )}
    </div>
  );
}
