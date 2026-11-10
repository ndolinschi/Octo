import { hrefFor } from "../../lib/route";
import { useProject } from "../../state/project";

export function ObserverBar() {
  const { projectId } = useProject();
  return (
    <div className="mx-auto w-full max-w-measure pb-4">
      <div role="note" className="flex min-h-10 items-center gap-3 rounded-lg bg-raised py-1.5 pr-1.5 pl-3.5 text-sm">
        <p className="min-w-0 flex-1 text-fg-2">Read-only. Only the orchestrator can direct this agent.</p>
        <a
          href={hrefFor(projectId)}
          className="inline-flex h-7 shrink-0 items-center rounded-sm px-2 text-fg transition-[background-color] duration-100 hover:bg-hover"
        >
          Back to orchestrator
        </a>
      </div>
    </div>
  );
}
