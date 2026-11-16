import type { AccessMode, ProjectMode, TierPolicy } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { withComments } from "../../lib/comments";
import { effectiveMode, modeToSend, nextMode } from "../../lib/modes";
import { promptText } from "../../lib/transcript";
import { modelsPatchForSessionChoice, servedModel } from "../../lib/models";
import { canMoveToWorktree, isDefaultSession, sessionWorkspaceLabel } from "../../lib/sessions/current";
import { useApp } from "../../state/app";
import { useOptionalComments } from "../../state/comments";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { ComposerMode, ComposerProps } from "./Composer";
import { draftOf } from "./composerDraft";
import type { QueuedMessage } from "./ComposerPills";
import { slot, type TabMemory } from "../../state/workspace/tabMemory";
import type { TabId } from "../../state/workspace/layout";
import { useSessionScope } from "../../state/session";
import { useHost } from "../../state/host";
import { deviceMay } from "../../lib/remoteDevice";
import { getStagedDesignNotes, setStagedDesignNotes, useStagedDesignNotesCount } from "../../state/designNotes";

/** Composers sharing a draft key (the Chat tab's and the floating one) hear each other's edits. */
type Listener = () => void;
const isQueue = (v: unknown): v is QueuedMessage[] =>
  Array.isArray(v) &&
  v.every((q: unknown) => typeof q === "object" && q !== null && "id" in q && "text" in q && typeof (q as { text: unknown }).text === "string");
const QUEUE = slot("queue", isQueue);
const QUEUE_LISTENERS = slot("queue:listeners", (v): v is Set<Listener> => v instanceof Set);
const EMPTY: QueuedMessage[] = [];

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
export function useOrchestratorComposer(tab: TabId): Omit<ComposerProps, "comments"> & { commentCount: number; designNoteCount: number } {
  const { health, config, bridge } = useApp();
  const device = useHost().remoteDevice;
  const { projectId, project, state, running, send, cancel, live, update, loadFailures, applySession } = useProject();
  const ws = useOptionalWorkspace();
  const comments = useOptionalComments();
  const designNoteCount = useStagedDesignNotesCount(projectId);
  const memory = ws?.memory;
  // Decision 96: a session's draft and local queue are its own, wherever its composer is (its tab, Chat, the floating one).
  const scope = useSessionScope();
  const key = scope?.memoryKey ?? tab;
  const activeSessionId = scope?.sessionId ?? ws?.chatSessionId ?? state.sessions.defaultId ?? null;
  const activeSession = scope?.session ?? (activeSessionId ? state.sessions.list.find((s) => s.id === activeSessionId) : undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [pendingTier, setPendingTier] = useState<TierPolicy | null>(null);
  const [pendingAccess, setPendingAccess] = useState<AccessMode | null>(null);
  // Parity B3: the mode chosen for the next message only; it resets once that message is sent.
  const [override, setOverride] = useState<ProjectMode | null>(null);
  const modeValue = effectiveMode(override, project?.mode);
  const orchestratorId = project?.orchestrator_agent_id;
  const orchestrator = orchestratorId ? state.agents[orchestratorId] : undefined;
  const messages = orchestratorId ? state.messages[orchestratorId] : undefined;
  const loadFailed = loadFailures[""] !== undefined || (orchestratorId !== undefined && messages === undefined && loadFailures[orchestratorId] !== undefined);
  const current = pending ?? project?.models.orchestrator ?? null;
  const queue = useQueue(memory, key);
  const draft = useMemo(() => (memory ? draftOf(memory, key) : undefined), [memory, key]);
  const lastRequest = useMemo(() => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const m = messages?.[i];
      if (m?.role === "user" && m.content.some((b) => b.type === "text")) return promptText(m);
    }
    return null;
  }, [messages]);

  const onSend = useCallback(
    async (text: string, extra?: { attachments?: string[] }) => {
      // Pending code comments and staged Browser Design Mode annotations ride along as fenced wire blocks, then clear.
      const prepared = comments ? await comments.prepare() : null;
      const stagedNotes = projectId ? getStagedDesignNotes(projectId) : [];
      const upload = bridge.uploadAttachment;
      const preparedDesign = stagedNotes.length
        ? await import("../../lib/browser/designNotes").then((m) =>
            m.prepareDesignNotes(stagedNotes, upload ? (data, o) => upload(projectId, data, o) : undefined),
          )
        : null;
      const withCode = prepared ? withComments(text, prepared.block) : text;
      const body = preparedDesign ? (withCode.trim() ? `${withCode.trim()}\n\n${preparedDesign.block}` : preparedDesign.block) : withCode;
      const attachments = [...(extra?.attachments ?? []), ...(preparedDesign?.attachments ?? [])];
      const mode = modeToSend(override, project?.mode);
      const opts = { ...(mode ? { mode } : {}), ...(attachments.length ? { attachments } : {}) };
      await send(body, Object.keys(opts).length ? opts : undefined);
      prepared?.commit();
      if (preparedDesign) {
        setStagedDesignNotes(
          projectId,
          getStagedDesignNotes(projectId).filter((n) => !preparedDesign.sentIds.has(n.id)),
        );
      }
      setOverride(null);
    },
    [comments, bridge.uploadAttachment, projectId, send, override, project?.mode],
  );
  const modeApi = useMemo<ComposerMode | null>(() => {
    // Without plan approval the harness predates modes: no chip.
    if (!bridge.approvePlan) return null;
    const projectDefault = project?.mode ?? "agent";
    return {
      value: modeValue,
      isDefault: modeValue === projectDefault,
      choose: setOverride,
      cycle: () => setOverride((cur) => nextMode(effectiveMode(cur, project?.mode))),
      makeDefault: async () => {
        await update({ mode: modeValue });
        setOverride(null);
      },
    };
  }, [bridge.approvePlan, modeValue, project?.mode, update]);

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
  const currentDefaultId = state.sessions.currentId ?? "";
  const sessionProp = useMemo<ComposerProps["session"]>(() => {
    if (!activeSession || !ws) return undefined;
    const title = activeSession.title.trim() || "New session";
    const isDef = isDefaultSession(activeSession);
    return {
      title,
      isDefault: isDef,
      branch: sessionWorkspaceLabel(activeSession),
      onMakeDefault: isDef
        ? undefined
        : () => {
            void bridge.setDefaultSession(projectId, activeSession.id).then((updated) => {
              applySession({ kind: "upsert", session: updated });
              applySession({ kind: "current", id: updated.id, previous: currentDefaultId });
            });
          },
      onShowAll: () => ws.openTool("sessions"),
      ...(bridge.moveSessionToWorktree && canMoveToWorktree(activeSession)
        ? {
            worktree: {
              projectId,
              session: activeSession,
              onMoved: (res) => applySession({ kind: "upsert", session: res.session }),
            },
          }
        : {}),
    };
  }, [activeSession, ws, bridge, projectId, applySession, currentDefaultId]);
  return {
    running,
    // P2-3: the conversation stays on screen while the service is away; the composer says why it is off.
    // Remote access: a device that may not send (read-only, or sends not allowed); the composer says where that changes.
    disabledReason: !deviceMay(device, "send")
      ? device?.readOnly
        ? "Read-only"
        : "Sending is off"
      : health === "offline"
        ? // B3: the banner says what is wrong and what to do; the field only says why it is off.
          "Offline"
        : loadFailed
          ? // B3: the service answers but the session did not load ("Couldn't load the session · Retry" above): not "Reconnecting…".
            "Waiting for the session to load…"
          : live === "reconnecting"
            ? "Reconnecting…"
            : null,
    folders: project?.folders ?? [],
    notice: noKey
      ? {
          text: "No API key yet. Pick a coding agent in the model chip, or add a key in Settings.",
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
    designNoteCount,
    lastRequest,
    context: { used: orchestrator?.context_used, size: orchestrator?.context_size },
    serverQueue: bridge.sendOrQueueMessage !== undefined,
    queue: { items: queue.items, add: queue.add, remove: queue.remove },
    model: current
      ? {
          value: current,
          title: served?.asked ? `${served.name} (asked for ${served.asked})` : undefined,
          unavailable: project?.models_unavailable?.some((i) => i.field === "orchestrator") === true,
          choose: async (model, force) => {
            if (!project || model === project.models.orchestrator) return;
            setPending(model);
            try {
              await update({ models: modelsPatchForSessionChoice(model, project.models), ...(force ? { force_unverified: true } : {}) });
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
    mode: modeApi,
    access: project
      ? {
          value: pendingAccess ?? project.access ?? "supervised",
          choose: async (next) => {
            if (next === (project.access ?? "supervised")) return;
            setPendingAccess(next);
            try {
              await update({ access: next });
            } finally {
              setPendingAccess(null);
            }
          },
        }
      : null,
    session: sessionProp,
    onSend,
    acceptsImages: project?.accepts_images,
    onCancel: cancel,
    draft,
  };
}
