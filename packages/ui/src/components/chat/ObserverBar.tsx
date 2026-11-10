import { ArrowLeft } from "lucide-react";
import { useProject } from "../../state/project";
import { hrefFor } from "../../lib/route";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Glyph } from "../primitives/Glyph";

/**
 * Bottom bar of an Agent tab, in the composer's place: the transcript is read-only. The composer's box
 * (radius 12, 6px inset, 40px) on one line at every width: the note truncates (full text in the
 * tooltip), and under 360px the link shrinks to its icon (its name stays the accessible name).
 */
export function ObserverBar() {
  const { projectId } = useProject();
  const ws = useOptionalWorkspace();
  const note = "Read-only. Only the orchestrator can direct this agent.";
  return (
    <div role="note" className="@container/obs">
      <div className="flex h-bar items-center gap-2 rounded-xl bg-raised p-1.5 text-sm outline -outline-offset-1 outline-line">
        <p className="min-w-0 flex-1 truncate px-2 text-fg-2" title={note}>
          {note}
        </p>
        <a
          href={hrefFor(projectId)}
          aria-label="Back to orchestrator"
          title="Back to orchestrator"
          onClick={(e) => {
            if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            ws.focusChat();
          }}
          className="press inline-flex h-7 shrink-0 items-center gap-2 rounded-sm px-2 text-fg hover:bg-hover @max-[360px]/obs:w-7 @max-[360px]/obs:justify-center @max-[360px]/obs:px-0"
        >
          <Glyph icon={ArrowLeft} size={16} className="hidden @max-[360px]/obs:block" />
          <span className="@max-[360px]/obs:hidden">Back to orchestrator</span>
        </a>
      </div>
    </div>
  );
}
