import { useMemo, useState } from "react";
import { withComments } from "../../lib/comments";
import { useApp } from "../../state/app";
import { modelIds, servedModel } from "../../lib/models";
import { useOptionalComments } from "../../state/comments";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { ComposerProps } from "./Composer";
import { slot, isString, type TabMemory } from "../../state/workspace/tabMemory";
import type { TabId } from "../../state/workspace/layout";

/** Composers sharing a draft key (the Chat tab's and the floating one) hear each other's edits. */
type DraftListener = (text: string) => void;
const DRAFT = slot("draft", isString);
const DRAFT_LISTENERS = slot("draft:listeners", (v): v is Set<DraftListener> => v instanceof Set);

function listeners(memory: TabMemory, tab: TabId): Set<DraftListener> {
  const existing = memory.get(tab, DRAFT_LISTENERS);
  if (existing) return existing;
  const set = new Set<DraftListener>();
  memory.set(tab, DRAFT_LISTENERS, set);
  return set;
}

/**
 * Everything a composer that talks to the orchestrator needs (the Chat tab's and the floating one
 * over files): send with pending code comments, stop, offline reason, the draft kept in the tab
 * memory under `tab`, and the orchestrator model choice (optimistic, rolled back on failure).
 */
export function useOrchestratorComposer(tab: TabId): Omit<ComposerProps, "comments"> & { commentCount: number } {
  const { health, config } = useApp();
  const { project, state, running, send, cancel, live, update } = useProject();
  const comments = useOptionalComments();
  const ws = useOptionalWorkspace();
  const memory = ws?.memory;
  const [pending, setPending] = useState<string | null>(null);
  const orchestratorId = project?.orchestrator_agent_id;
  const messages = orchestratorId ? state.messages[orchestratorId] : undefined;
  const current = pending ?? project?.models.orchestrator ?? null;

  // The project's configured models, then the bridge's defaults; each once, in that order.
  // Model ids only: `auto_candidates` (a list) and `tier_policy` are settings values but not models.
  const known = useMemo(
    () =>
      modelIds(
        project?.models.orchestrator,
        project?.models.deep,
        project?.models.balanced,
        project?.models.fast,
        ...Object.values(config?.default_models ?? {}),
      ),
    [project?.models, config],
  );
  const policy = project?.models.tier_policy ?? "auto";
  const root = orchestratorId ? state.agents[orchestratorId] : undefined;
  const served = current && root?.served_model ? servedModel({ model: current, served_model: root.served_model }, config?.acp_orchestrators ?? []) : null;
  const servedTitle = served?.asked ? `${served.asked} → ${served.name} (chosen → served by the router)` : undefined;
  // No API key and no router: the built-in loop cannot run, so a project on a Messages API model would fail (ACP agents
  // still work). One quiet line says so and where to go — never a dead end.
  const loop = config?.builtin_loop;
  const noKey = loop?.available === false && !(current ?? "").startsWith("acp:");
  const loopReason = loop?.reason;

  return {
    running,
    disabledReason: health === "offline" ? "Bridge offline. Start harness serve to continue." : live === "reconnecting" ? "Reconnecting to the bridge…" : null,
    followUp: (messages?.length ?? 0) > 0,
    folders: project?.folders ?? [],
    commentCount: comments?.comments.length ?? 0,
    notice: noKey
      ? {
          text: "No API key set. Choose an agent on a subscription below, or give the harness a key.",
          ...(loopReason ? { title: loopReason } : {}),
        }
      : null,
    onFolders: ws ? ws.openSettings : undefined,
    // Decision 49: a chosen folder joins the project (kept if it is already there).
    onAddFolder: project
      ? (path: string) => {
          if (project.folders.some((f) => f.path === path)) return;
          // A failed update leaves the project's folders as they were: the chip keeps showing the unchanged list.
          void update({ folders: [...project.folders.map((f) => ({ path: f.path, label: f.label })), { path }] }).catch(() => undefined);
        }
      : undefined,
    // Routing applies to Messages API models behind the router, not to an orchestrator that runs as an ACP agent.
    policy:
      config?.router && project && !(current ?? "").startsWith("acp:")
        ? { value: policy, onChange: (p) => void update({ models: { tier_policy: p } }).catch(() => undefined) }
        : null,
    model: current
      ? {
          value: current,
          known,
          title: servedTitle,
          tiers: project ? { fast: project.models.fast, balanced: project.models.balanced, deep: project.models.deep } : null,
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
    draft: memory
      ? {
          initial: memory.get(tab, DRAFT) ?? "",
          save: (text) => {
            if (memory.get(tab, DRAFT) === text) return;
            memory.set(tab, DRAFT, text);
            listeners(memory, tab).forEach((l) => l(text));
          },
          subscribe: (cb) => {
            const set = listeners(memory, tab);
            set.add(cb);
            return () => void set.delete(cb);
          },
        }
      : undefined,
  };
}
