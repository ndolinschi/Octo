import { ArrowLeft } from "lucide-react";
import { useProject } from "../../state/project";
import { hrefFor } from "../../lib/route";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Glyph } from "../primitives/Glyph";

/**
 * Bottom bar of an Agent tab, in the composer's place: the transcript is read-only. The composer's box
 * (radius 12, 6px inset, 40px) on one line at every width: where the sentence does not fit beside the link (a side group,
 * a phone) the note says "Read-only" with the sentence in its tooltip, and under 360px the link shrinks to its icon (its
 * name stays the accessible name). One line keeps the lazy bar's 40px placeholder exact.
 */
export function ObserverBar() {
  const { projectId } = useProject();
  const ws = useOptionalWorkspace();
  const note = "Read-only. Only the main session can direct this agent.";
  return (
    <div role="note" className="@container/obs">
      <div className="flex h-bar items-center gap-2 rounded-xl bg-raised p-1.5 text-sm outline -outline-offset-1 outline-line">
        <p className="min-w-0 flex-1 truncate px-2 text-fg-2" title={note}>
          <span className="@max-[560px]/obs:hidden">{note}</span>
          <span className="hidden @max-[560px]/obs:inline">Read-only</span>
        </p>
        <a
          href={hrefFor(projectId)}
          aria-label="Back to session"
          title="Back to session"
          onClick={(e) => {
            if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            ws.focusChat();
          }}
          className="inline-flex h-7 shrink-0 press items-center gap-2 rounded-sm px-2 text-fg hover:bg-hover @max-[360px]/obs:w-7 @max-[360px]/obs:justify-center @max-[360px]/obs:px-0"
        >
          <Glyph icon={ArrowLeft} size={16} className="hidden @max-[360px]/obs:block" />
          <span className="@max-[360px]/obs:hidden">Back to session</span>
        </a>
      </div>
    </div>
  );
}
