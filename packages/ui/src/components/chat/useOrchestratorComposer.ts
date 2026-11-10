import { useMemo, useState } from "react";
import { withComments } from "../../lib/comments";
import { useApp } from "../../state/app";
import { useOptionalComments } from "../../state/comments";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { ComposerProps } from "./Composer";

/**
 * Everything a composer that talks to the orchestrator needs (the Chat tab's and the floating one
 * over files): send with pending code comments, stop, offline reason, the draft kept in the tab
 * memory under `draftKey`, and the orchestrator model choice (optimistic, rolled back on failure).
 */
export function useOrchestratorComposer(draftKey: string): Omit<ComposerProps, "comments"> & { commentCount: number } {
  const { health, config } = useApp();
  const { project, state, running, send, cancel, live, update } = useProject();
  const comments = useOptionalComments();
  const memory = useOptionalWorkspace()?.memory;
  const [pending, setPending] = useState<string | null>(null);
  const orchestratorId = project?.orchestrator_agent_id;
  const messages = orchestratorId ? state.messages[orchestratorId] : undefined;
  const current = pending ?? project?.models.orchestrator ?? null;

  // The project's configured models, then the bridge's defaults; each once, in that order.
  const options = useMemo(() => {
    const ids = [project?.models.orchestrator, project?.models.deep, project?.models.balanced, project?.models.fast, ...Object.values(config?.default_models ?? {})];
    return [...new Set(ids.filter((m): m is string => Boolean(m && m.trim())))];
  }, [project?.models, config]);

  return {
    running,
    disabledReason: health === "offline" ? "Bridge offline. Start harness serve to continue." : live === "reconnecting" ? "Reconnecting to the bridge…" : null,
    followUp: (messages?.length ?? 0) > 0,
    folders: project?.folders ?? [],
    commentCount: comments?.comments.length ?? 0,
    model: current
      ? {
          value: current,
          options,
          choose: async (model) => {
            if (!project || model === project.models.orchestrator) return;
            setPending(model);
            try {
              await update({ models: { orchestrator: model } });
            } finally {
              setPending(null);
            }
          },
        }
      : null,
    onSend: async (text) => {
      // Pending code comments ride along as an `octo-comments` block, then clear.
      const prepared = comments ? await comments.prepare() : null;
      await send(prepared ? withComments(text, prepared.block) : text);
      prepared?.commit();
    },
    onCancel: cancel,
    draft: memory ? { initial: (memory.get(draftKey) as string | undefined) ?? "", save: (text) => memory.set(draftKey, text) } : undefined,
  };
}
