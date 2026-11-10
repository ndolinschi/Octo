import { totalTokens } from "@octo/agent-client";
import { requestTitle } from "../../lib/comments";
import { formatTokens } from "../../lib/format";
import type { RequestSummary } from "../../lib/transcript";
import { useNavState } from "../../state/nav";
import { useProject } from "../../state/project";
import { RunningDot } from "../primitives/Status";

/**
 * The Chat tab's header, on the conversation column's edges (it never repeats the tab strip): where you
 * are — project / the request in view — and, on the right, whether the orchestrator is working and the
 * tokens the project has used as a quiet tabular count.
 */
export function ChatHeader({ requests }: { requests: RequestSummary[] }) {
  const { project, projectId, state, running } = useProject();
  const { viewTurn } = useNavState();
  if (!project) return null;
  const inView = viewTurn?.projectId === projectId ? requests.find((r) => r.id === viewTurn.messageId) : undefined;
  const request = inView ?? requests[requests.length - 1];
  const tokens = totalTokens(state);
  const total = tokens.input + tokens.output;
  return (
    <div data-chat-header className="shrink-0 px-[calc(var(--pad)+var(--sg))] pt-2">
      <div data-column-edge className="mx-auto flex h-row w-full max-w-measure min-w-0 items-center gap-2 text-sm">
        <p className="flex min-w-0 flex-1 items-center gap-2">
          <span className="max-w-[40%] shrink-0 truncate text-fg-2" title={project.name}>
            {project.name}
          </span>
          {request && (
            <>
              <span aria-hidden className="text-fg-3">
                /
              </span>
              <span className="min-w-0 truncate text-fg" title={request.text}>
                {requestTitle(request.text).split("\n", 1)[0]}
              </span>
            </>
          )}
        </p>
        {running && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-fg-2">
            <RunningDot />
            Working…
          </span>
        )}
        {total > 0 && (
          <span
            className="shrink-0 text-xs text-fg-3 tabular-nums"
            title={`${total.toLocaleString()} tokens used in this project (${tokens.input.toLocaleString()} in, ${tokens.output.toLocaleString()} out)`}
          >
            <span className="sr-only">Tokens used: </span>
            {formatTokens(total)}
          </span>
        )}
      </div>
    </div>
  );
}
