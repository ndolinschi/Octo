import type { TurnChanges } from "@octo/agent-client";
import { useMemo, useState } from "react";
import { earlierRequestLabel } from "../../lib/v7/changes";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { PanelEmpty } from "../primitives/Panel";
import { ChangesView, type ChangesViewProps } from "./ChangesView";
import type { ChangesApi } from "./useChanges";
import { useV7Events } from "./useV7Events";

const LABEL_MAX = 60;

export type ChangesTabProps = Pick<ChangesViewProps, "loadMonaco" | "focusTurn" | "focusFile" | "onShowAll" | "onAddComment" | "commentsFor" | "onOpenFile">;

/**
 * Dock tab (v7 §1, decision 47): what the agents changed in the open project. Binds `listChanges` / `getChange` /
 * `revertChange` to the project and reloads on `change.recorded`. Says so when the harness predates them.
 */
export function ChangesTab(props: ChangesTabProps) {
  const { bridge } = useApp();
  if (!bridge.listChanges || !bridge.getChange || !bridge.revertChange) {
    return (
      <PanelEmpty title="Changes aren't available">
        This version of Octo&apos;s local service does not record changes. Update it to review what agents changed.
      </PanelEmpty>
    );
  }
  return <Live {...props} />;
}

function Live(props: ChangesTabProps) {
  const { bridge, theme } = useApp();
  const { projectId, project, state } = useProject();
  const [recorded, setRecorded] = useState(0);
  useV7Events((e) => {
    if (e.type === "change.recorded") setRecorded((n) => n + 1);
  });
  const api = useMemo<ChangesApi>(
    () => ({
      listChanges: () => bridge.listChanges?.(projectId) ?? Promise.resolve([]),
      getChange: (id) => bridge.getChange?.(projectId, id) ?? Promise.reject(new Error("Octo's local service cannot show this change")),
      revertChange: (id) => bridge.revertChange?.(projectId, id) ?? Promise.reject(new Error("Octo's local service cannot revert this change")),
    }),
    [bridge, projectId],
  );
  const orchestratorId = project?.orchestrator_agent_id;
  const messages = orchestratorId ? state.messages[orchestratorId] : undefined;
  // A turn is the id of the user message that started it: its first words say which request changed the files.
  const turnLabel = (turn: TurnChanges) => {
    const m = messages?.find((x) => x.id === turn.turn_id);
    const text = m?.content.find((b) => b.type === "text");
    const line = text && "text" in text ? text.text.replace(/\s+/g, " ").trim() : "";
    return line ? (line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line) : earlierRequestLabel(turn, Date.now());
  };
  return <ChangesView api={api} theme={theme} refreshKey={recorded} turnLabel={turnLabel} {...props} />;
}
