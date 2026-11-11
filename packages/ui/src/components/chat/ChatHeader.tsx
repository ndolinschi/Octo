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
import { OrchestratorGlyph } from "../primitives/Status";
import { budgetState, middleEllipsis, modelIds, modelName, servedModel } from "../../lib/models";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { GLYPH } from "../primitives/glyphs";
import { MOD_LABEL } from "../../lib/keys";
import { ModelPicker } from "../shared/ModelPicker";
import { TeamLine } from "./TeamLine";

/**
 * The orchestrator's header (decision 23): one 40px row on the conversation column's edges, outside the scroll area.
 * Left: the project's name, its orchestrator's state ring and words ("Working", "Needs you", "Idle, 2h ago"), then the
 * team line (decision 34: live, last run or who it can call on — the one place the team shows; the strip above the
 * composer is gone). Right: the model that answers (decision 37: the served model, the requested one in its tooltip;
 * opens the model picker), "$spent / $budget" when the project has a budget (amber from 80%, red at 100%), the
 * project's tokens, the side question (decision 40) and a `…` menu. No request breadcrumb: the request in view is
 * shown by the rail and the pinned prompt. `transparent` on the empty project, where the streak runs behind it.
 */
export function ChatHeader({ transparent = false }: { transparent?: boolean }) {
  const { project, state, running, update } = useProject();
  const { config } = useApp();
  const { openProjectInEditor } = useHost();
  const ws = useOptionalWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Decision 47: header text that does not fit moves into the "⋯" menu instead of being cut.
  const [collapsedTeam, setCollapsedTeam] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const now = useNow(running);
  const orchestrator = useMemo(() => liveOrchestratorState(state, running ? "running" : "idle"), [state, running]);
  if (!project) return null;
  const tokens = totalTokens(state);
  const total = tokens.input + tokens.output;
  const agents = orchestrator.kind === "working" ? orchestrator.agents : [];
  const line = stateLine(orchestrator, now, project.updated_at);
  const acp = config?.acp_orchestrators ?? [];
  const root = state.agents[project.orchestrator_agent_id];
  // The model that answered the latest request (a router may pick another); the setting when nothing was reported.
  const served = root?.served_model ? servedModel({ model: project.models.orchestrator, served_model: root.served_model }, acp) : null;
  // Decision 48: one display label everywhere (middle-truncated in the header); "chosen → served" in the tooltip.
  const chosen = modelName(project.models.orchestrator, acp);
  const shownModel = middleEllipsis(served?.name ?? chosen, 24, 8);
  const budget = budgetState(project.spent_usd, project.budget_usd);
  const known = modelIds(
    project.models.orchestrator,
    project.models.deep,
    project.models.balanced,
    project.models.fast,
    ...Object.values(config?.default_models ?? {}),
  );
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
        <TeamLine orchestrator={orchestrator} onCollapsed={setCollapsedTeam} />
        <span className="flex shrink-0 @max-[560px]/conv:hidden">
          <ModelPicker
            label="Orchestrator model"
            variant="text"
            value={project.models.orchestrator}
            known={known}
            tiers={{ fast: project.models.fast, balanced: project.models.balanced, deep: project.models.deep }}
            policy={
              config?.router
                ? { value: project.models.tier_policy ?? "auto", onChange: (p) => void update({ models: { tier_policy: p } }).catch(() => undefined) }
                : null
            }
            onChoose={(m) => void update({ models: { orchestrator: m } }).catch(() => undefined)}
            title={served?.asked ? `${served.asked} → ${served.name} (chosen → served by the router)` : `Orchestrator model: ${served?.name ?? chosen}`}
            className="-mx-1.5"
          >
            {shownModel}
          </ModelPicker>
        </span>
        {budget && (
          <span
            data-budget
            className={cn("shrink-0 text-xs tabular-nums", budget.tone === "err" ? "text-err" : budget.tone === "warn" ? "text-warn" : "text-fg-3")}
            title={`${budget.reached ? "Project budget reached. Raise it in project settings to continue. " : ""}Spent ${budget.text} of the project's budget`}
          >
            <span className="sr-only">Budget: </span>
            {budget.reached ? "Project budget reached" : budget.text}
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
        {ws && (
          <IconButton
            icon={GLYPH.side}
            label="Ask a side question"
            title={`Ask a side question (${MOD_LABEL};) without interrupting the orchestrator`}
            className="-mr-1.5"
            onClick={() => ws.openTool("side")}
          />
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
              ...(collapsedTeam
                ? [
                    { id: "team", label: collapsedTeam, disabled: true, run: () => undefined },
                    { id: "sep0", separator: true as const },
                  ]
                : []),
              { id: "agents", label: "Show agents", disabled: !ws, run: () => ws?.openTool("agents") },
              { id: "details", label: "Show project details", disabled: !ws, run: () => ws?.openTool("details") },
              { id: "usage", label: "Show usage", disabled: !ws, run: () => ws?.openTool("usage") },
              { id: "side", label: "Ask a side question", shortcut: `${MOD_LABEL};`, disabled: !ws, run: () => ws?.openTool("side") },
              { id: "sep", separator: true },
              ...(openProjectInEditor
                ? [{ id: "editor", label: "Open in editor", disabled: project.folders.length === 0, run: () => openProjectInEditor(project.id) }]
                : []),
              { id: "settings", label: "Project settings", disabled: !ws, run: () => ws?.openSettings() },
            ]}
          />
        )}
      </Presence>
    </div>
  );
}
