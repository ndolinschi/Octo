import { totalTokens } from "@octo/agent-client";
import { formatTokens } from "../../lib/format";
import { startDownload } from "../../lib/download";
import { MOD_LABEL } from "../../lib/keys";
import { budgetState } from "../../lib/models";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Menu } from "../primitives/Menu";

/** The "⋯" menu of the project's actions. Its own chunk: `ProjectActions` loads it when the menu is first opened. */
export default function ProjectActionsMenu(props: { x: number; y: number; onClose(): void }) {
  const { project, state } = useProject();
  const { openProjectInEditor } = useHost();
  const { bridge } = useApp();
  const ws = useOptionalWorkspace();
  if (!project) return null;
  const tokens = totalTokens(state);
  const total = tokens.input + tokens.output;
  const budget = budgetState(project.spent_usd, project.budget_usd);
  return (
    <Menu
      label="Project actions"
      x={props.x}
      y={props.y}
      alignEnd
      onClose={props.onClose}
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
        ...(bridge.exportConversationUrl
          ? [{ id: "export", label: "Export conversation (Markdown)", run: () => startDownload(bridge.exportConversationUrl?.(project.id) ?? "") }]
          : []),
        { id: "settings", label: "Project settings", disabled: !ws, run: () => ws?.openSettings() },
      ]}
    />
  );
}
