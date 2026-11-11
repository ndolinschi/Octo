import { totalTokens } from "@octo/agent-client";
import { Ellipsis } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { liveOrchestratorState, stateLine } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { modelLabel, OrchestratorGlyph } from "../primitives/Status";
import { TeamLine } from "./TeamLine";

/**
 * The orchestrator's header (decision 23): one 40px row on the conversation column's edges, outside the scroll area.
 * Left: the project's name, its orchestrator's state ring and words ("Working", "Needs you", "Idle, 2h ago"), then the
 * team line (decision 34: live, last run or who it can call on). Right: the orchestrator's model, the project's tokens
 * and a `…` menu. No request breadcrumb: the request in view is
 * shown by the rail and the pinned prompt. `transparent` on the empty project, where the streak runs behind it.
 */
export function ChatHeader({ transparent = false }: { transparent?: boolean }) {
  const { project, state, running } = useProject();
  const ws = useOptionalWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const now = useNow(running);
  const orchestrator = useMemo(() => liveOrchestratorState(state, running ? "running" : "idle"), [state, running]);
  if (!project) return null;
  const tokens = totalTokens(state);
  const total = tokens.input + tokens.output;
  const agents = orchestrator.kind === "working" ? orchestrator.agents : [];
  const line = stateLine(orchestrator, now, project.updated_at);
  return (
    <div data-chat-header className={cn("relative shrink-0 overflow-hidden px-(--pad) scroll-quiet", !transparent && "bg-panel")}>
      <div data-column-edge className="mx-auto flex h-bar w-full max-w-measure min-w-0 items-center gap-3 text-sm">
        <p className="flex max-w-[50%] min-w-0 shrink-0 items-center gap-2">
          <span className="min-w-0 shrink truncate font-medium text-fg" title={project.name}>
            {project.name}
          </span>
          <span
            className={cn("flex shrink-0 items-center gap-1.5 text-xs", orchestrator.kind === "needs" ? "text-warn" : running ? "text-fg-2" : "text-fg-3")}
            title={orchestrator.kind === "needs" ? (orchestrator.error ?? "The last turn failed") : `Orchestrator: ${line}`}
          >
            <OrchestratorGlyph state={orchestrator.kind} />
            <span className="sr-only">Orchestrator: </span>
            {/* The agent count is in the stack when there is room; the state word stays. */}
            <span className="@max-[420px]/conv:hidden">{agents.length ? "Working" : line}</span>
          </span>
        </p>
        <TeamLine orchestrator={orchestrator} />
        <span className="shrink-0 text-xs text-fg-3 @max-[560px]/conv:hidden" title={`Orchestrator model: ${project.models.orchestrator}`}>
          {modelLabel(project.models.orchestrator)}
        </span>
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
          label="Orchestrator actions"
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
            label="Orchestrator actions"
            x={menu.x}
            y={menu.y}
            alignEnd
            onClose={() => setMenu(null)}
            items={[
              { id: "agents", label: "Show agents", disabled: !ws, run: () => ws?.openTool("agents") },
              { id: "usage", label: "Show usage", disabled: !ws, run: () => ws?.openTool("usage") },
              { id: "settings", label: "Project settings", disabled: !ws, run: () => ws?.openSettings() },
            ]}
          />
        )}
      </Presence>
    </div>
  );
}
