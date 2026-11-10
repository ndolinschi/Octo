import { ArrowLeft, Eye } from "lucide-react";
import { hrefFor } from "../../lib/route";
import { useProject } from "../../state/project";

export function ObserverBar({ role }: { role: string }) {
  const { projectId } = useProject();
  return (
    <div className="mx-auto w-full max-w-measure pb-6">
      <div
        role="note"
        className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong bg-raised/40 py-2 pr-2 pl-3.5"
      >
        <Eye size={15} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-3" />
        <p className="min-w-0 flex-1 text-sm text-fg-2">
          <span className="font-medium text-fg">Read-only</span> — you're observing {role}. Only the orchestrator can direct it.
        </p>
        <a
          href={hrefFor(projectId)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 text-sm text-fg transition-colors hover:bg-hover"
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
          Back to orchestrator
        </a>
      </div>
    </div>
  );
}
