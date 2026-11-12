import { useMemo } from "react";
import { commandsApi, type CommandsApi } from "../../lib/commands/api";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

/** The command methods of the bridge for the open project, or null when the bridge has none (decision 68). */
export function useCommandsApi(): CommandsApi | null {
  const { bridge } = useApp();
  const { projectId } = useProject();
  return useMemo(() => commandsApi(bridge, projectId), [bridge, projectId]);
}
