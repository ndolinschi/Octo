import { totalTokens } from "@octo/agent-client";
import { Ellipsis } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { requestTitle } from "../../lib/comments";
import { formatTokens } from "../../lib/format";
import { useCopy } from "../../lib/hooks";
import type { RequestSummary } from "../../lib/transcript";
import { useNavState } from "../../state/nav";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { RunningDot } from "../primitives/Status";

/**
 * The Chat tab's header: one opaque 40px row on the conversation column's edges, outside the scroll
 * area (the transcript starts below it and never slides under it). Left: where you are — project /
 * the request in view. Right: whether the orchestrator is working, the tokens the project has used as
 * a quiet tabular count, and a `…` menu (Copy request, Project settings). The menu button's 28px box
 * overhangs the column by 6px, so its 16px glyph ends exactly on the column edge.
 */
export function ChatHeader({ requests }: { requests: RequestSummary[] }) {
  const { project, projectId, state, running } = useProject();
  const ws = useOptionalWorkspace();
  const { viewTurn } = useNavState();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [, copy] = useCopy();
  if (!project) return null;
  const inView = viewTurn?.projectId === projectId ? requests.find((r) => r.id === viewTurn.messageId) : undefined;
  const request = inView ?? requests[requests.length - 1];
  const tokens = totalTokens(state);
  const total = tokens.input + tokens.output;
  return (
    <div data-chat-header className="scroll-quiet shrink-0 overflow-hidden bg-panel px-(--pad)">
      <div data-column-edge className="mx-auto flex h-bar w-full max-w-measure min-w-0 items-center gap-3 text-sm">
        <p className="flex min-w-0 flex-1 items-center gap-2">
          {/* Under 420px of conversation the project crumb goes first (it is in the sidebar and the tab). */}
          <span className={cn("max-w-[40%] shrink-0 truncate text-fg-2", request && "@max-[420px]/conv:hidden")} title={project.name}>
            {project.name}
          </span>
          {request && (
            <>
              <span aria-hidden className="text-fg-3 @max-[420px]/conv:hidden">
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
        <IconButton
          ref={button}
          icon={Ellipsis}
          label="Conversation actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          className={cn("-mr-1.5", menu && "bg-active text-fg")}
          onClick={() => {
            const r = button.current?.getBoundingClientRect();
            if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
          }}
        />
      </div>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="Conversation actions"
            x={menu.x}
            y={menu.y}
            alignEnd
            onClose={() => setMenu(null)}
            items={[
              { id: "copy", label: "Copy request", disabled: !request, run: () => request && copy(request.text) },
              { id: "settings", label: "Project settings", disabled: !ws, run: () => ws?.openSettings() },
            ]}
          />
        )}
      </Presence>
    </div>
  );
}
