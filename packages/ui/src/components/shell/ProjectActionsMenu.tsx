import { totalTokens } from "@octo/agent-client";
import { formatTokens, structuredError, errorMessage } from "../../lib/format";
import { saveConversation } from "../../lib/download";
import { MOD_LABEL } from "../../lib/keys";
import { budgetState } from "../../lib/modelsMore";
import { mayChangeProject, ON_YOUR_COMPUTER } from "../../lib/remoteDevice";
import { sessionChoices } from "../../lib/sessions/picker";
import { isTabEnabled } from "../../lib/tabFlags";
import { useApp } from "../../state/app";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { useTabFlags } from "../../state/tabFlags";
import type { ToolTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Menu, type MenuItem } from "../primitives/Menu";
import { sessionMenuItems, useCreateProjectSession, useSyncProjectSessions } from "./sessionSwitcher";

/** A failed action in the shape `ErrorNotice` takes: the harness's `message`, `hint`, `action`, `details`. */
export type Failure = NonNullable<ReturnType<typeof structuredError>> & { title?: string };

/** The "⋯" menu of the project's actions. Its own chunk: `ProjectActions` loads it when the menu is first opened. */
export default function ProjectActionsMenu(props: {
  x: number;
  y: number;
  onClose(): void;
  /** A failed action (session create or export): the owner shows it as the standard error notice, with the harness's own message. */
  onFailure(failure: Failure): void;
}) {
  const { project, state } = useProject();
  const { openProjectInEditor, remoteDevice } = useHost();
  const { bridge } = useApp();
  const tabFlags = useTabFlags();
  const ws = useOptionalWorkspace();
  const createSession = useCreateProjectSession();
  useSyncProjectSessions(Boolean(project));
  if (!project) return null;
  const canShow = (tool: ToolTab) => (ws ? ws.toolEnabled(tool) : isTabEnabled(tabFlags, tool, { memoryBlocked: project.memory?.auto_memory === "blocked" }));
  const tokens = totalTokens(state);
  const total = tokens.input + tokens.output;
  const budget = budgetState(project.spent_usd, project.budget_usd);
  const sessions = sessionChoices(state.sessions.list);
  const activeId = ws?.chatSessionId ?? state.sessions.defaultId;
  const toolItems: MenuItem[] = [
    ...(canShow("agents") ? [{ id: "agents", label: "Show agents", disabled: !ws, run: () => ws?.openTool("agents") }] : []),
    ...(canShow("details") ? [{ id: "details", label: "Show project details", disabled: !ws, run: () => ws?.openTool("details") }] : []),
    ...(canShow("usage") ? [{ id: "usage", label: "Show usage", disabled: !ws, run: () => ws?.openTool("usage") }] : []),
    ...(canShow("side") ? [{ id: "side", label: "Ask a side question", shortcut: `${MOD_LABEL};`, disabled: !ws, run: () => ws?.openTool("side") }] : []),
  ];
  return (
    <Menu
      label="Project actions"
      x={props.x}
      y={props.y}
      alignEnd
      onClose={props.onClose}
      items={[
        ...sessionMenuItems({
          sessions,
          activeId,
          disabled: !ws,
          onSelect: (id) => ws?.showSession(id),
          onCreate: (target) =>
            void createSession(target).catch((e: unknown) =>
              props.onFailure({ ...(structuredError(e) ?? { message: errorMessage(e) }), title: "Could not start session" }),
            ),
          ...(canShow("sessions") ? { onShowAll: () => ws?.openTool("sessions") } : {}),
        }),
        ...(toolItems.length > 0 ? [{ id: "sep-tools", separator: true as const }, ...toolItems] : []),
        { id: "sep", separator: true },
        ...(openProjectInEditor
          ? [{ id: "editor", label: "Open in editor", disabled: project.folders.length === 0, run: () => openProjectInEditor(project.id) }]
          : []),
        ...(bridge.exportConversation || bridge.exportConversationUrl
          ? [
              {
                id: "export",
                label: "Export session (Markdown)",
                run: () =>
                  void saveConversation(bridge, project.id).catch((e: unknown) =>
                    props.onFailure({ ...(structuredError(e) ?? { message: errorMessage(e) }), title: "Could not export" }),
                  ),
              },
            ]
          : []),
        mayChangeProject(remoteDevice)
          ? { id: "settings", label: "Project settings", disabled: !ws, run: () => ws?.openSettings() }
          : { id: "settings", label: "Project settings", sub: ON_YOUR_COMPUTER, disabled: true, run: () => undefined },
        ...(total > 0 || budget?.tone === "fg-3"
          ? [
              { id: "sep-footer", separator: true as const },
              ...(total > 0
                ? [
                    {
                      id: "tokens",
                      caption: `${formatTokens(total)} tokens used`,
                      title: `${total.toLocaleString()} tokens used in this project (${tokens.input.toLocaleString()} in, ${tokens.output.toLocaleString()} out)`,
                    },
                  ]
                : []),
              ...(budget?.tone === "fg-3" ? [{ id: "budget", caption: `Budget: ${budget.text}` }] : []),
            ]
          : []),
      ]}
    />
  );
}
