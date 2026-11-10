import { useProject } from "../../state/project";
import { hrefFor } from "../../lib/route";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";

/** Bottom bar of an Agent tab, in the composer's place: the transcript is read-only. */
export function ObserverBar() {
  const { projectId } = useProject();
  const ws = useOptionalWorkspace();
  return (
    <div role="note" className="flex min-h-[42px] flex-wrap items-center gap-x-3 rounded-xl border border-line bg-raised py-1.5 pr-1.5 pl-3.5 text-sm">
      <p className="min-w-0 grow basis-[220px] text-fg-2">Read-only. Only the orchestrator can direct this agent.</p>
      <a
        href={hrefFor(projectId)}
        onClick={(e) => {
          if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          ws.focusChat();
        }}
        className="press ml-auto inline-flex h-7 shrink-0 items-center rounded-sm px-2 text-fg hover:bg-hover"
      >
        Back to orchestrator
      </a>
    </div>
  );
}
