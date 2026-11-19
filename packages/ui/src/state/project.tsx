import {
  emptyProjectState,
  hasParallelSessions,
  retryDelay,
  sessionRoot,
  type BridgeEvent,
  type Note,
  type NoteDocument,
  type NoteInput,
  type NotePatch,
  type Project,
  type ProjectInput,
  type ProjectMode,
  type ProjectSession,
  type ProjectState,
  type SendResult,
} from "@octo/agent-client";
import { rewoundLabel } from "../lib/compact";
import { withDeadline } from "../lib/deadline";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useApp } from "./app";
import { useActivity } from "./activity";
import { projectReducer } from "./projectReducer";
import { transcriptSession } from "../lib/sessions/current";
import { errorMessage } from "../lib/format";
import { SUMMARY_DISAGREE_MS } from "../lib/constants";
import { useLatest } from "../lib/hooks";
import { createRequiredContext } from "../lib/context";
import { keepLatest, projectSnapshots, type ProjectKept } from "./projectCache";

export type SessionChange = { kind: "upsert"; session: ProjectSession } | { kind: "remove"; ids: string[] } | { kind: "current"; id: string; previous: string };

export type LiveStatus = "connecting" | "live" | "reconnecting";

type ProjectValue = {
  projectId: string;
  project: Project | null;
  loadError: string | null;
  /** A14: loads that failed and are retried with backoff (`reload` tries now), by agent id or `""` (the project itself). */
  loadFailures: Readonly<Record<string, string>>;
  /** Bumped by every re-read after a reconnect: views that load their own lists (queue, approvals, forms) load them again. */
  synced: number;
  state: ProjectState;
  live: LiveStatus;
  /** The default session's turn runs (inside a `SessionScope`: that session's). */
  running: boolean;
  /** Parallel sessions (schema 15): the harness addresses each main session; a conversation is one session's. */
  parallel: boolean;
  /** A message to main session `sessionId` (it starts its turn or waits in its queue), with the same read-back as `send`. */
  sendIn(sessionId: string, text: string, opts?: { mode?: ProjectMode; attachments?: string[] }): Promise<SendResult>;
  /** Stops main session `sessionId`'s turn (and pauses its queue). */
  cancelIn(sessionId: string): Promise<void>;
  reload(): Promise<void>;
  ensureMessages(agentId: string): void;
  /** `mode` (parity B3) overrides the project's default for this message only. */
  send(text: string, opts?: { mode?: ProjectMode; attachments?: string[] }): Promise<void>;
  cancel(): Promise<void>;
  /** The texts `message.steered` named this session: those user messages landed in a running turn (parity B6). */
  steered: readonly string[];
  /** The conversation was cut by a rewind (parity B5): apply it now rather than waiting for the event. `root`: the rewound session's root. */
  applyRewind(messageId: number, label: string, root?: string): void;
  update(patch: Partial<ProjectInput>): Promise<Project>;
  createNote(input: NoteInput): Promise<NoteDocument>;
  updateNote(id: string, patch: NotePatch): Promise<NoteDocument>;
  deleteNote(id: string): Promise<void>;
  /** Side questions (decision 40): ask (the answer arrives as side.* events), load the stored ones, clear them. */
  askSide(text: string): Promise<void>;
  loadSide(): Promise<void>;
  clearSide(): Promise<void>;
  /**
   * Applies a session change the person just made to `state.sessions` at once (the harness's `session.*` events say the same
   * a moment later; applying both is harmless). A bridge without those events (the demo's memory sessions) relies on this.
   */
  applySession(change: SessionChange): void;
  /** Observe raw bridge events on this project's existing subscription (no extra connection). */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
  /** What the conversation's own reads found (its queue, its stored endings), kept across switches (decision 99). */
  kept: ProjectKept;
};

export const { Provider: ProjectContextProvider, useRequired: useProject, useOptional: useOptionalProject } = createRequiredContext<ProjectValue>("useProject");

/** A note as the list holds it: no body (M5). */
function listed(doc: NoteDocument): Note {
  const { content: _body, markdown: _source, ...note } = doc;
  return note;
}

export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { bridge, refreshProjects, refreshConfig, projects, probe } = useApp();
  // A project read before starts from what was known then (decision 99): its conversation paints complete in the first frame,
  // and `syncAll` below reads everything again, as after a reopened stream (A11).
  const [kept] = useState(() => projectSnapshots(bridge).get(projectId));
  const [state, dispatch] = useReducer(projectReducer, undefined, () => kept?.state ?? emptyProjectState());
  const [project, setProject] = useState<Project | null>(kept?.project ?? null);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const loaded = useRef(new Set<string>(kept?.loaded));
  const [reads] = useState<ProjectKept>(() => kept?.kept ?? { queues: new Map(), endings: new Map(), files: new Map() });
  useEffect(() => {
    if (project) keepLatest(projectSnapshots(bridge), projectId, { project, state, loaded: loaded.current, kept: reads });
  }, [bridge, projectId, project, state, reads]);
  const observers = useRef(new Set<(event: BridgeEvent) => void>());
  const [steered, setSteered] = useState<readonly string[]>([]);
  const [synced, setSynced] = useState(0);
  const [epoch, setEpoch] = useState(0);

  // A14: loads that failed, by agent id (its conversation) or "" (the project). While any is here, `syncAll` (which reads
  // the project and every conversation asked for) runs again with backoff, and at once when the window gets focus (a
  // reopened stream does the same; a harness that was offline remounts the whole workspace).
  const [loadFailures, setLoadFailures] = useState<Record<string, string>>({});
  const fail = useCallback((key: string, e: unknown) => setLoadFailures((f) => ({ ...f, [key]: errorMessage(e) })), []);
  const ok = useCallback(
    (key: string) =>
      setLoadFailures((f) => {
        if (!(key in f)) return f;
        const { [key]: _gone, ...rest } = f;
        return rest;
      }),
    [],
  );

  const fetchMessages = useCallback(
    async (agentId: string, scope?: { sessionId?: string }) => {
      loaded.current.add(agentId);
      try {
        // The transcript carries the compaction markers (decision 37). (`listMessages` reads the same URL: no fallback to it.)
        // P2-4: a read never answered fails after its deadline, and the load retry takes over.
        const transcript = await withDeadline(
          bridge.getTranscript(projectId, agentId, scope?.sessionId === undefined ? undefined : { sessionId: scope.sessionId }),
        );
        // A resumed session's conversation replaces what the state held (ids of two sessions must not mix).
        if (scope) dispatch({ type: "transcript", agentId, messages: transcript.messages, markers: transcript.compactions });
        else {
          dispatch({ type: "messages", agentId, messages: transcript.messages });
          if (transcript.compactions.length) dispatch({ type: "compactions", agentId, markers: transcript.compactions });
        }
        ok(agentId);
      } catch (e) {
        // Still counted as asked for (`loaded`): the conversation shows the failure with Retry, and `syncAll` tries again.
        fail(agentId, e);
      }
    },
    [bridge, projectId, fail, ok],
  );

  const sessionsRef = useLatest(state.sessions);
  const stateRef = useLatest(state);
  const orchestratorRef = useRef<string | null>(null);
  /** `session.current`: the conversation shows the new current session (resumed: only its messages; the newest: all, with markers). */
  const showSession = useCallback(
    (currentId: string) => {
      const agentId = orchestratorRef.current;
      // Parallel sessions: every session is its own root's conversation; nothing is swapped in place.
      if (!agentId || hasParallelSessions(stateRef.current)) return;
      // The event may arrive before the list has the session: `transcriptSession` then reads an older list and shows everything.
      const sessionId = transcriptSession(sessionsRef.current.list, currentId);
      void fetchMessages(agentId, sessionId === undefined ? {} : { sessionId });
    },
    [fetchMessages, sessionsRef, stateRef],
  );

  const syncAll = useCallback(async () => {
    try {
      const [p, agents, notes, sessions] = await withDeadline(
        Promise.all([
          bridge.getProject(projectId),
          bridge.listAgents(projectId),
          bridge.listNotes(projectId),
          // Project sessions: an older harness has none; a failed read leaves the list as it is (`session.*` events keep it current).
          bridge.listSessions ? withDeadline(bridge.listSessions(projectId, { limit: 200, archived: "all" })).catch(() => null) : null,
        ]),
      );
      setProject(p);
      orchestratorRef.current = p.orchestrator_agent_id;
      ok("");
      dispatch({ type: "agents", agents });
      dispatch({ type: "notes", notes });
      if (sessions) dispatch({ type: "sessions", sessions });
      // NEW-3: what waits for the person (a helper waiting for an approval reads "Waiting for your approval", not "Thinking…"),
      // also when it was asked before this window opened. Unreadable: events still bring new ones. Awaited with the messages: a
      // project read ahead of a switch (decision 99) shows its cards with the transcript.
      const waits = Promise.all([
        bridge.listApprovals ? withDeadline(bridge.listApprovals(projectId)).catch(() => null) : null,
        bridge.listInputs ? withDeadline(bridge.listInputs(projectId)).catch(() => null) : null,
      ]).then(([approvals, inputs]) => dispatch({ type: "waits", approvals, inputs }));
      // A resumed (older) session stays what the conversation shows after a reload or reconnect (before parallel sessions only:
      // since then each session is its own root's messages).
      const parallel = sessions?.some((s) => s.kind === "main" && s.default !== undefined) ?? false;
      const resumed = sessions && !parallel ? transcriptSession(sessions, sessions.find((s) => s.kind === "main" && s.current)?.id ?? null) : undefined;
      const ids = new Set([p.orchestrator_agent_id, ...loaded.current]);
      await Promise.all([
        waits,
        ...[...ids].map((id) => fetchMessages(id, id === p.orchestrator_agent_id && resumed !== undefined ? { sessionId: resumed } : undefined)),
      ]);
      // A11: what the stream missed is in the stored messages now; streamed text of a turn that ended goes.
      dispatch({ type: "settle" });
      setSynced((n) => n + 1);
    } catch (e) {
      fail("", e);
    }
  }, [bridge, projectId, fetchMessages, fail, ok]);

  const failing = Object.keys(loadFailures).length > 0;
  const attempt = useRef(0);
  useEffect(() => {
    if (!failing) {
      attempt.current = 0;
      return;
    }
    const retry = () => void syncAll();
    // Each failed round sets new failures, which runs this again with the next delay: 1 s, 2 s, 4 s … 30 s.
    const id = window.setTimeout(retry, retryDelay((attempt.current += 1)));
    window.addEventListener("focus", retry);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("focus", retry);
    };
  }, [failing, loadFailures, syncAll]);

  useEffect(() => {
    let opened = false;
    const unsubscribe = bridge.subscribe(projectId, {
      onOpen: () => {
        setLive("live");
        probe(true);
        if (opened) void syncAll();
        opened = true;
      },
      onError: () => {
        setLive("reconnecting");
        // P2-3: a failed stream is the first sign the service went away; the health poll alone takes up to 15 s.
        probe();
      },
      onEvent: (event) => {
        dispatch({ type: "event", event });
        if (event.type === "project.updated") setProject(event.project);
        if (event.type === "message.steered") setSteered((s) => [...s, event.text]);
        if (event.type === "conversation.rewound") {
          const root = event.session_id ? sessionRoot(stateRef.current, event.session_id) : "";
          dispatch({
            type: "rewound",
            messageId: event.message_id,
            label: rewoundLabel(false),
            at: new Date().toISOString(),
            soft: true,
            ...(root ? { root } : {}),
          });
          void syncAll();
        }
        // The client's reducer keeps only the position of a compaction; a manual one also carries its label and size.
        if (event.type === "agent.compacted" && event.manual) {
          const { type: _type, seq: _seq, agent_id: agentId, ...marker } = event;
          dispatch({ type: "compactions", agentId, markers: [{ ...marker, label: "history compacted" }] });
        }
        if (event.type === "session.current") showSession(event.session_id);
        if (event.type === "settings.changed") void refreshConfig();
        if (event.type === "turn.finished" || event.type === "project.updated" || event.type === "project.attention") void refreshProjects();
        for (const observe of observers.current) observe(event);
      },
    });
    void syncAll();
    return unsubscribe;
    // `epoch`: a new subscription (and a full re-read) when the polled summary and the stream disagree.
  }, [bridge, projectId, syncAll, refreshProjects, refreshConfig, showSession, probe, epoch, stateRef]);

  // The sidebar and Home read the open project's orchestrator state from its live agents (decision 23).
  const activity = useActivity();
  useEffect(() => {
    if (!state.agentOrder.length) return;
    activity.setLiveAgents(
      projectId,
      state.agentOrder.flatMap((id) => {
        const a = state.agents[id];
        return a ? [a] : [];
      }),
    );
  }, [activity, projectId, state.agents, state.agentOrder]);
  useEffect(() => () => activity.setLiveAgents(projectId, null), [activity, projectId]);
  // The sidebar's tree lists the open project's sessions live from this stream (decision 96).
  const sessionList = state.sessions.list;
  useEffect(() => {
    if (synced > 0 || sessionList.length > 0) activity.setLiveSessions(projectId, sessionList);
  }, [activity, projectId, sessionList, synced]);
  useEffect(() => () => activity.setLiveSessions(projectId, null), [activity, projectId]);
  useEffect(() => {
    const onReset = () => {
      loaded.current.clear();
      void syncAll();
    };
    window.addEventListener("octo:sessions-reset", onReset);
    return () => window.removeEventListener("octo:sessions-reset", onReset);
  }, [syncAll]);

  const orchestrator = project ? state.agents[project.orchestrator_agent_id] : undefined;
  const running = orchestrator?.status === "running" || (project?.status === "running" && !orchestrator);
  const parallel = hasParallelSessions(state);
  // Any session at work (the polled summary's `running` means that since parallel sessions).
  const anyRunning = parallel ? Object.values(state.agents).some((a) => a.parent_id === null && a.status === "running") || running : running;

  // A16: the polled project list says whether a turn runs. When it disagrees with what the stream told us for a while, the
  // stream is suspect (half-open, or an event was lost): open a new one and re-read. Once per disagreement, so a project
  // whose summary counts a sub-agent's work as running costs one re-read, not a loop.
  const summary = projects?.find((x) => x.id === projectId);
  const disagree = project !== null && summary !== undefined && (summary.status === "running") !== anyRunning;
  useEffect(() => {
    if (!disagree) return;
    const id = window.setTimeout(() => setEpoch((n) => n + 1), SUMMARY_DISAGREE_MS);
    return () => window.clearTimeout(id);
  }, [disagree]);

  const value = useMemo<ProjectValue>(
    () => ({
      projectId,
      project,
      loadError: loadFailures[""] ?? null,
      loadFailures,
      synced,
      state,
      live,
      running,
      parallel,
      reload: syncAll,
      ensureMessages: (agentId) => {
        if (!loaded.current.has(agentId)) void fetchMessages(agentId);
      },
      send: async (text, opts) => {
        // While a turn runs the harness queues the message (`queue.updated` shows it); `sendMessage` would refuse it.
        // A message with its own mode goes the same way: only `sendOrQueueMessage` carries one.
        if ((running || opts) && bridge.sendOrQueueMessage) {
          if (!running) dispatch({ type: "clearTurn" });
          const sent = await bridge.sendOrQueueMessage(projectId, text, opts);
          if (sent.message) dispatch({ type: "messages", agentId: sent.message.agent_id, messages: [sent.message] });
          if (!running) void refreshProjects();
          return;
        }
        dispatch({ type: "clearTurn" });
        const message = await bridge.sendMessage(projectId, text);
        dispatch({ type: "messages", agentId: message.agent_id, messages: [message] });
        void refreshProjects();
      },
      cancel: () => bridge.cancelTurn(projectId),
      sendIn: async (sessionId, text, opts) => {
        const root = sessionRoot(state, sessionId);
        const busy = root !== "" && state.agents[root]?.status === "running";
        if (!busy) dispatch({ type: "clearTurn", sessionId });
        const sent = await bridge.sendSessionMessage(projectId, sessionId, text, opts);
        if (sent.message) dispatch({ type: "messages", agentId: sent.message.agent_id, messages: [sent.message] });
        if (!busy) void refreshProjects();
        return sent;
      },
      cancelIn: async (sessionId) => {
        await bridge.stopSession(projectId, sessionId);
      },
      steered,
      applyRewind: (messageId, label, root) => dispatch({ type: "rewound", messageId, label, at: new Date().toISOString(), ...(root ? { root } : {}) }),
      update: async (patch) => {
        const next = await bridge.updateProject(projectId, patch);
        setProject(next);
        void refreshProjects();
        return next;
      },
      createNote: async (input) => {
        const doc = await bridge.createNote(projectId, input);
        dispatch({ type: "notes", notes: [...state.notes.filter((n) => n.id !== doc.id), listed(doc)] });
        return doc;
      },
      updateNote: async (id, patch) => {
        const doc = await bridge.updateNote(projectId, id, patch);
        dispatch({ type: "notes", notes: state.notes.map((n) => (n.id === id ? listed(doc) : n)) });
        return doc;
      },
      deleteNote: async (id) => {
        await bridge.deleteNote(projectId, id);
        dispatch({ type: "notes", notes: state.notes.filter((n) => n.id !== id) });
      },
      askSide: async (text) => {
        dispatch({ type: "sideAsked", started: await bridge.askSide(projectId, text) });
      },
      loadSide: async () => {
        dispatch({ type: "side", messages: await bridge.listSide(projectId) });
      },
      clearSide: async () => {
        await bridge.clearSide(projectId);
        dispatch({ type: "sideCleared" });
      },
      applySession: (change) => {
        if (change.kind === "upsert") dispatch({ type: "event", event: { type: "session.updated", seq: 0, session: change.session } });
        else if (change.kind === "remove")
          for (const id of change.ids) dispatch({ type: "event", event: { type: "session.updated", seq: 0, session_id: id, deleted: true } });
        else {
          dispatch({ type: "event", event: { type: "session.current", seq: 0, session_id: change.id, previous_session_id: change.previous } });
          showSession(change.id);
        }
      },
      onEvent: (listener) => {
        observers.current.add(listener);
        return () => {
          observers.current.delete(listener);
        };
      },
      kept: reads,
    }),
    [projectId, project, loadFailures, synced, state, live, running, parallel, syncAll, fetchMessages, bridge, steered, showSession, refreshProjects, reads],
  );

  return <ProjectContextProvider value={value}>{children}</ProjectContextProvider>;
}
