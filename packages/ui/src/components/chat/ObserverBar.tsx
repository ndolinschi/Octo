import { useProject } from "../../state/project";
import { hrefFor } from "../../lib/route";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";

/** Bottom bar of an Agent tab, in the composer's place: the transcript is read-only. */
export function ObserverBar() {
  const { projectId } = useProject();
  const ws = useOptionalWorkspace();
  return (
    // The composer's box: radius 12, 8px inset, text on the composer's 16px line.
    <div role="note" className="flex flex-wrap items-center gap-x-3 rounded-xl border border-line bg-raised p-2 text-sm">
      <p className="min-w-0 grow basis-[220px] px-2 text-fg-2">Read-only. Only the orchestrator can direct this agent.</p>
      <a
        href={hrefFor(projectId)}
        onClick={(e) => {
          if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          ws.focusChat();
        }}
        className="press ml-auto inline-flex h-row shrink-0 items-center rounded-xs px-2 text-fg hover:bg-hover"
      >
        Back to orchestrator
      </a>
    </div>
  );
}
