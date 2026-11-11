import type { TierPolicy } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { withComments } from "../../lib/comments";
import { promptText } from "../../lib/transcript";
import { servedModel } from "../../lib/models";
import { useApp } from "../../state/app";
import { useOptionalComments } from "../../state/comments";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { ComposerProps } from "./Composer";
import type { QueuedMessage } from "./ComposerPills";
import { slot, isString, type TabMemory } from "../../state/workspace/tabMemory";
import type { TabId } from "../../state/workspace/layout";

/** Composers sharing a draft key (the Chat tab's and the floating one) hear each other's edits. */
type Listener = () => void;
const DRAFT = slot("draft", isString);
const DRAFT_LISTENERS = slot("draft:listeners", (v): v is Set<(text: string) => void> => v instanceof Set);
const isQueue = (v: unknown): v is QueuedMessage[] =>
  Array.isArray(v) &&
  v.every((q: unknown) => typeof q === "object" && q !== null && "id" in q && "text" in q && typeof (q as { text: unknown }).text === "string");
const QUEUE = slot("queue", isQueue);
const QUEUE_LISTENERS = slot("queue:listeners", (v): v is Set<Listener> => v instanceof Set);
const EMPTY: QueuedMessage[] = [];

function draftListeners(memory: TabMemory, tab: TabId): Set<(text: string) => void> {
  const existing = memory.get(tab, DRAFT_LISTENERS);
  if (existing) return existing;
  const set = new Set<(text: string) => void>();
  memory.set(tab, DRAFT_LISTENERS, set);
  return set;
}

function queueListeners(memory: TabMemory, tab: TabId): Set<Listener> {
  const existing = memory.get(tab, QUEUE_LISTENERS);
  if (existing) return existing;
  const set = new Set<Listener>();
  memory.set(tab, QUEUE_LISTENERS, set);
  return set;
}

let queueId = 0;

/**
 * Messages written while a turn runs (decision 62's Queue), kept in the tab memory so both composers on the key show
 * the same queue, and sent one at a time when a turn completes. A failed or stopped turn holds the queue (the pills
 * stay; removing one is the way out) so nothing runs after a failure unasked.
 */
function useQueue(memory: TabMemory | undefined, tab: TabId) {
  const subscribe = useCallback(
    (cb: Listener) => {
      if (!memory) return () => undefined;
      const set = queueListeners(memory, tab);
      set.add(cb);
      return () => void set.delete(cb);
    },
    [memory, tab],
  );
  const items = useSyncExternalStore(subscribe, () => memory?.get(tab, QUEUE) ?? EMPTY);
  const write = useCallback(
    (next: QueuedMessage[]) => {
      if (!memory) return;
      memory.set(tab, QUEUE, next);
      queueListeners(memory, tab).forEach((l) => l());
    },
    [memory, tab],
  );
  const take = useCallback((): QueuedMessage | null => {
    const [first, ...rest] = memory?.get(tab, QUEUE) ?? EMPTY;
    if (!first) return null;
    write(rest);
    return first;
  }, [memory, tab, write]);
  const add = useCallback((text: string) => write([...(memory?.get(tab, QUEUE) ?? EMPTY), { id: `q${(queueId += 1)}`, text }]), [memory, tab, write]);
  const remove = useCallback((id: string) => write((memory?.get(tab, QUEUE) ?? EMPTY).filter((q) => q.id !== id)), [memory, tab, write]);
  return { items, take, add, remove };
}

/**
 * Everything a composer that talks to the orchestrator needs (the Chat tab's and the floating one over files): send
 * with pending code comments, stop, queue, offline reason, the draft kept in the tab memory under `tab`, the model
 * (optimistic, rolled back on failure), the router's tier policy and the context meter.
 */
export function useOrchestratorComposer(tab: TabId): Omit<ComposerProps, "comments"> & { commentCount: number } {
  const { health, config, bridge } = useApp();
  const { project, state, running, send, cancel, live, update } = useProject();
  const comments = useOptionalComments();
  const memory = useOptionalWorkspace()?.memory;
  const [pending, setPending] = useState<string | null>(null);
  const [pendingTier, setPendingTier] = useState<TierPolicy | null>(null);
  const orchestratorId = project?.orchestrator_agent_id;
  const orchestrator = orchestratorId ? state.agents[orchestratorId] : undefined;
  const messages = orchestratorId ? state.messages[orchestratorId] : undefined;
  const current = pending ?? project?.models.orchestrator ?? null;
  const queue = useQueue(memory, tab);
  const lastRequest = useMemo(() => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const m = messages?.[i];
      if (m?.role === "user" && m.content.some((b) => b.type === "text")) return promptText(m);
    }
    return null;
  }, [messages]);

  const onSend = useCallback(
    async (text: string) => {
      // Pending code comments ride along as an `octo-comments` block, then clear.
      const prepared = comments ? await comments.prepare() : null;
      await send(prepared ? withComments(text, prepared.block) : text);
      prepared?.commit();
    },
    [comments, send],
  );

  // The next queued message goes out once per completed turn (not after a failure or a stop); a send that fails puts it
  // back, where its pill shows it is still waiting.
  const lastTurn = state.lastTurn;
  const flushed = useRef<object | null>(null);
  const { take, add, items: queued } = queue;
  useEffect(() => {
    if (running || live !== "live" || lastTurn?.status !== "completed" || flushed.current === lastTurn || !queued.length) return;
    flushed.current = lastTurn;
    const next = take();
    if (next) onSend(next.text).catch(() => add(next.text));
  }, [running, live, lastTurn, queued.length, take, add, onSend]);

  const policy: TierPolicy = pendingTier ?? project?.models.tier_policy ?? "auto";
  const served =
    current && orchestrator?.served_model ? servedModel({ model: current, served_model: orchestrator.served_model }, config?.acp_orchestrators ?? []) : null;
  // No API key and no router: the built-in loop cannot run, so a Messages API model would fail (ACP agents still work).
  const loop = config?.builtin_loop;
  const acp = (current ?? "").startsWith("acp:");
  const noKey = loop?.available === false && !acp;
  return {
    running,
    failed: orchestrator?.status === "failed" || (!running && state.lastTurn?.status === "failed"),
    disabledReason: health === "offline" ? "Bridge offline. Start harness serve to continue." : live === "reconnecting" ? "Reconnecting to the bridge…" : null,
    folders: project?.folders ?? [],
    notice: noKey
      ? {
          text: "No API key set. Choose an agent on a subscription in the model chip, or give the harness a key.",
          ...(loop?.reason ? { title: loop.reason } : {}),
        }
      : null,
    // Decision 49: a chosen folder joins the project (kept if it is already there).
    onAddFolder: project
      ? (path: string) => {
          if (project.folders.some((f) => f.path === path)) return;
          // A failed update leaves the project's folders as they were: the chip keeps showing the unchanged list.
          void update({ folders: [...project.folders.map((f) => ({ path: f.path, label: f.label })), { path }] }).catch(() => undefined);
        }
      : undefined,
    commentCount: comments?.comments.length ?? 0,
    lastRequest,
    context: { used: orchestrator?.context_used, size: orchestrator?.context_size },
    serverQueue: bridge.sendOrQueueMessage !== undefined,
    queue: { items: queue.items, add: queue.add, remove: queue.remove },
    model: current
      ? {
          value: current,
          title: served?.asked ? `${served.asked} → ${served.name} (chosen → served by the router)` : undefined,
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
    tier:
      // Routing applies to Messages API models behind the router, not to an orchestrator that runs as an ACP agent.
      config?.router && !acp
        ? {
            value: policy,
            choose: async (next) => {
              setPendingTier(next);
              try {
                await update({ models: { tier_policy: next } });
              } finally {
                setPendingTier(null);
              }
            },
          }
        : null,
    onSend,
    onCancel: cancel,
    draft: memory
      ? {
          initial: memory.get(tab, DRAFT) ?? "",
          save: (text) => {
            if (memory.get(tab, DRAFT) === text) return;
            memory.set(tab, DRAFT, text);
            draftListeners(memory, tab).forEach((l) => l(text));
          },
          subscribe: (cb) => {
            const set = draftListeners(memory, tab);
            set.add(cb);
            return () => void set.delete(cb);
          },
        }
      : undefined,
  };
}
