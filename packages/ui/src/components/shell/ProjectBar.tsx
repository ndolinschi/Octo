import { totalTokens } from "@octo/agent-client";
import { Ellipsis } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/format";
import { MOD_LABEL } from "../../lib/keys";
import { budgetState } from "../../lib/models";
import { liveOrchestratorState } from "../../lib/orchestrator";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { Menu } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { ProjectTeam } from "./ProjectTeam";

/**
 * What the open project puts in the window's top row (decision 67; the row is the tab strips, `dock/TabStrip`). Next to the
 * conversation's tab: its sub-agents (`ProjectTeamLine`, decision 34); at the far end of the last strip: the "⋯" menu with the project's actions (`ProjectActions`). The model is chosen
 * in the composer only. Project commands (decision 68) belong between the two, next to the "+" (not built here).
 */
export function ProjectTeamLine() {
  const { project, state, running } = useProject();
  const orchestrator = useMemo(() => liveOrchestratorState(state, running ? "running" : "idle"), [state, running]);
  if (!project) return null;
  return <ProjectTeam orchestrator={orchestrator} />;
}

export function ProjectActions() {
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
