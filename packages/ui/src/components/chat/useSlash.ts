import type { SlashCommands } from "@octo/agent-client";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useSessionScope } from "../../state/session";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { ComposerMode } from "./composerMode";
import { useInlineNotes } from "./notesContext";

/** Fetches the runner's chunk (called when `/` opens the menu), so the first command does not wait for the network. */
export function preloadSlashRunner(): void {
  // A failed fetch is retried by the real `import()` when a command runs, which reports it.
  void import("./slashRun").catch(() => undefined);
}

/** The commands of the open project (`getSlashCommands`), refetched on `slash_commands.updated`; null until known or without the endpoint. */
export function useSlashCommands(): SlashCommands | null {
  const { bridge } = useApp();
  const { projectId, project, onEvent } = useProject();
  const orchestrator = project?.models.orchestrator ?? "";
  const [commands, setCommands] = useState<SlashCommands | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    void bridge.getSlashCommands?.(projectId).then(
      (c) => alive && setCommands(c),
      // Not loaded: the menu shows the commands the UI runs itself, and a later `slash_commands.updated` asks again.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, projectId, orchestrator, round]);
  useEffect(() => onEvent((e) => e.type === "slash_commands.updated" && setRound((n) => n + 1)), [onEvent]);
  return bridge.getSlashCommands ? commands : null;
}

/**
 * Runs an Octo slash command (B11): the host action or the endpoint named by the command, with what it leaves in the
 * conversation as inline notes. Returns false when the name is not one it knows (the text is then sent as typed).
 */
export function useSlashRunner(ctx: { mode: ComposerMode | null | undefined; openModel(query: string): void }) {
  const { bridge } = useApp();
  const { projectId, project } = useProject();
  const ws = useOptionalWorkspace();
  const scope = useSessionScope();
  const notes = useInlineNotes();
  const push = notes?.push;
  const rewindLast = notes?.rewindLast;
  const { mode, openModel } = ctx;
  const memoryBlocked = project?.memory?.auto_memory === "blocked";
  return useCallback(
    async (name: string, args: string): Promise<boolean> => {
      // The runner (compact, export, remember ...) loads with the first command, not with the composer.
      const { runSlash } = await import("./slashRun");
      return runSlash(
        {
          bridge,
          projectId,
          mode,
          openModel,
          push,
          rewindLast,
          openTool: (t) => ws?.openTool(t),
          openSettings: () => ws?.openSettings(),
          // Decision 96: `/clear` makes a new session; this conversation follows it.
          onCleared: scope ? (next) => scope.follow(next) : undefined,
          memoryBlocked,
        },
        name,
        args,
      );
    },
    [bridge, projectId, ws, scope, push, rewindLast, mode, openModel, memoryBlocked],
  );
}
