import { useMemo, type ReactNode } from "react";
import { commandsApi, type CommandsApi } from "../../lib/commands/api";
import { createRequiredContext } from "../../lib/context";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useReviewRuns } from "./useReviewRuns";

type Value = ReturnType<typeof useReviewRuns> & { api: CommandsApi | null; worktreePresent: boolean; reviewId: string };

export const { Provider: RunsContextProvider, useRequired: useRuns } = createRequiredContext<Value>("useRuns");

/** The run state of one review, shared by the buttons in its header and the panel under its diff. */
export function ReviewRunsProvider(props: { reviewId: string; worktreePresent: boolean; children: ReactNode }) {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const api = useMemo(() => commandsApi(bridge, projectId), [bridge, projectId]);
  const runs = useReviewRuns(api, props.reviewId);
  const value = useMemo<Value>(
    () => ({ ...runs, api, worktreePresent: props.worktreePresent, reviewId: props.reviewId }),
    [runs, api, props.worktreePresent, props.reviewId],
  );
  return <RunsContextProvider value={value}>{props.children}</RunsContextProvider>;
}
