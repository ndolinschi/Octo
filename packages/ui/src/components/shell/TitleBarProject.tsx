import { totalTokens } from "@octo/agent-client";
import { Ellipsis } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { MOD_LABEL } from "../../lib/keys";
import { budgetState } from "../../lib/models";
import { liveOrchestratorState, stateLine } from "../../lib/orchestrator";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { useTitleBarSlots } from "../../state/titleBar";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { OrchestratorGlyph } from "../primitives/Status";
import { TitleBarTeam } from "./TitleBarTeam";

/**
 * What the open project puts in the title bar (decision 54; it replaces the conversation header of decision 23). Rendered
 * inside the project's providers and portalled into the shell's row: the name with the orchestrator's state ring and words
 * ("Working", "Needs you", "Idle, 2h ago"); at the far end the model that answers (decision 37: the served model, the
 * requested one in the tooltip; opens the model picker), "$spent / $budget" when the project has a budget (amber from 80%,
 * red at 100%), the project's tokens, the side question (decision 40) and a "⋯" menu. What does not fit goes away from
 * the right, never cut: the model chip first, then the state words and tokens.
 */
export function TitleBarProject() {
  const slots = useTitleBarSlots();
  const { project } = useProject();
  if (!project || !slots.start || !slots.end) return null;
  return (
    <>
      {createPortal(<Start />, slots.start)}
      {createPortal(<End />, slots.end)}
    </>
  );
}

function useOrchestratorLine() {
  const { project, state, running } = useProject();
  const now = useNow(running);
  const orchestrator = useMemo(() => liveOrchestratorState(state, running ? "running" : "idle"), [state, running]);
  const line = project ? stateLine(orchestrator, now, project.updated_at) : "";
  return { orchestrator, line, running };
}

function Start() {
  const { project } = useProject();
  const { orchestrator, line, running } = useOrchestratorLine();
  if (!project) return null;
  const working = orchestrator.kind === "working";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 shrink truncate font-medium text-fg" title={project.name}>
        {project.name}
      </span>
      <span
        className={cn("flex shrink-0 items-center gap-1.5 text-xs", orchestrator.kind === "needs" ? "text-warn" : running ? "text-fg-2" : "text-fg-3")}
        title={orchestrator.kind === "needs" ? (orchestrator.error ?? "The last turn failed") : line}
      >
        <OrchestratorGlyph state={orchestrator.kind} />
        <span className="sr-only">State: </span>
        <span className="@max-[520px]/title:hidden">{working ? "Working" : line}</span>
      </span>
      <TitleBarTeam orchestrator={orchestrator} />
    </div>
  );
}

function End() {
  const { project, state } = useProject();
  const { openProjectInEditor } = useHost();
  const ws = useOptionalWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  if (!project) return null;
  const tokens = totalTokens(state);
  const total = tokens.input + tokens.output;
  const budget = budgetState(project.spent_usd, project.budget_usd);
  return (
    <>
      {budget && budget.tone !== "fg-3" && (
        // Decision 64 a: the budget is a bar item only when it is a warning (80% and up); otherwise it is a line in "⋯".
        <span
          data-budget
          className={cn("shrink-0 text-xs tabular-nums @max-[520px]/title:hidden", budget.tone === "err" ? "text-err" : "text-warn")}
          title={`${budget.reached ? "Project budget reached. Raise it in project settings to continue. " : ""}Spent ${budget.text} of the project's budget`}
        >
          <span className="sr-only">Budget: </span>
          {budget.reached ? "Project budget reached" : budget.text}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1">
        <IconButton
          ref={button}
          icon={Ellipsis}
          label="Project actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          className={cn(menu && "bg-active text-fg")}
          onClick={() => {
            const r = button.current?.getBoundingClientRect();
            if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
          }}
        />
      </span>
      <Presence show={menu !== null} exitMs={0}>
        {menu && (
          <Menu
            label="Project actions"
            x={menu.x}
            y={menu.y}
            alignEnd
            onClose={() => setMenu(null)}
            items={[
              { id: "agents", label: "Show agents", disabled: !ws, run: () => ws?.openTool("agents") },
              { id: "details", label: "Show project details", disabled: !ws, run: () => ws?.openTool("details") },
              { id: "usage", label: "Show usage", disabled: !ws, run: () => ws?.openTool("usage") },
              { id: "side", label: "Ask a side question", shortcut: `${MOD_LABEL};`, disabled: !ws, run: () => ws?.openTool("side") },
              { id: "sep", separator: true },
              ...(total > 0
                ? [
                    {
                      id: "tokens",
                      label: `${formatTokens(total)} tokens used`,
                      title: `${total.toLocaleString()} tokens used in this project (${tokens.input.toLocaleString()} in, ${tokens.output.toLocaleString()} out)`,
                      disabled: true,
                      run: () => undefined,
                    },
                  ]
                : []),
              ...(budget && budget.tone === "fg-3" ? [{ id: "budget", label: `Budget: ${budget.text}`, disabled: true, run: () => undefined }] : []),
              ...(openProjectInEditor
                ? [{ id: "editor", label: "Open in editor", disabled: project.folders.length === 0, run: () => openProjectInEditor(project.id) }]
                : []),
              { id: "settings", label: "Project settings", disabled: !ws, run: () => ws?.openSettings() },
            ]}
          />
        )}
      </Presence>
    </>
  );
}
