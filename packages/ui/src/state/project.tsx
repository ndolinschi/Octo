import {
  emptyProjectState,
  type BridgeEvent,
  type Note,
  type NoteDocument,
  type NoteInput,
  type NotePatch,
  type Project,
  type ProjectInput,
  type ProjectMode,
  type ProjectState,
} from "@octo/agent-client";
import { rewoundLabel } from "../lib/compact";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useApp } from "./app";
import { useActivity } from "./activity";
import { projectReducer } from "./projectReducer";
import { errorMessage } from "../lib/format";
import { createRequiredContext } from "../lib/context";

export type LiveStatus = "connecting" | "live" | "reconnecting";

type ProjectValue = {
  projectId: string;
  project: Project | null;
  loadError: string | null;
  state: ProjectState;
  live: LiveStatus;
  running: boolean;
  reload(): Promise<void>;
  ensureMessages(agentId: string): void;
  /** `mode` (parity B3) overrides the project's default for this message only. */
  send(text: string, opts?: { mode: ProjectMode }): Promise<void>;
  cancel(): Promise<void>;
  /** The texts `message.steered` named this session: those user messages landed in a running turn (parity B6). */
  steered: readonly string[];
  /** The conversation was cut by a rewind (parity B5): apply it now rather than waiting for the event. */
  applyRewind(messageId: number, label: string): void;
  update(patch: Partial<ProjectInput>): Promise<Project>;
  createNote(input: NoteInput): Promise<NoteDocument>;
  updateNote(id: string, patch: NotePatch): Promise<NoteDocument>;
  deleteNote(id: string): Promise<void>;
  /** Side questions (decision 40): ask (the answer arrives as side.* events), load the stored ones, clear them. */
  askSide(text: string): Promise<void>;
  loadSide(): Promise<void>;
  clearSide(): Promise<void>;
  /** Observe raw bridge events on this project's existing subscription (no extra connection). */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
};

export const { Provider: ProjectContextProvider, useRequired: useProject } = createRequiredContext<ProjectValue>("useProject");

/** A note as the list holds it: no body (M5). */
function listed(doc: NoteDocument): Note {
  const { content: _body, markdown: _source, ...note } = doc;
  return note;
}

export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { bridge, refreshProjects } = useApp();
  const [state, dispatch] = useReducer(projectReducer, undefined, emptyProjectState);
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const loaded = useRef(new Set<string>());
  const observers = useRef(new Set<(event: BridgeEvent) => void>());
  const [steered, setSteered] = useState<readonly string[]>([]);

  const fetchMessages = useCallback(
    async (agentId: string) => {
      loaded.current.add(agentId);
      try {
        // The transcript carries the compaction markers (decision 37); an older harness only has the message list.
        const transcript = await bridge
          .getTranscript(projectId, agentId)
          .catch(async () => ({ messages: await bridge.listMessages(projectId, agentId), compactions: [] }));
        dispatch({ type: "messages", agentId, messages: transcript.messages });
        if (transcript.compactions.length) dispatch({ type: "compactions", agentId, markers: transcript.compactions });
      } catch {
        // Not loaded: the transcript shows its empty state, and the next `ensureMessages` (or a reconnect) tries again.
        loaded.current.delete(agentId);
      }
    },
    [bridge, projectId],
  );

  const syncAll = useCallback(async () => {
    try {
      const [p, agents, notes, sessions] = await Promise.all([
        bridge.getProject(projectId),
        bridge.listAgents(projectId),
        bridge.listNotes(projectId),
        // Project sessions: an older harness has none; a failed read leaves the list as it is (`session.*` events keep it current).
        bridge.listSessions ? bridge.listSessions(projectId, { limit: 200 }).catch(() => null) : null,
      ]);
      setProject(p);
      setLoadError(null);
      dispatch({ type: "agents", agents });
      dispatch({ type: "notes", notes });
      if (sessions) dispatch({ type: "sessions", sessions });
      const ids = new Set([p.orchestrator_agent_id, ...loaded.current]);
      await Promise.all([...ids].map(fetchMessages));
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [bridge, projectId, fetchMessages]);

  useEffect(() => {
    let opened = false;
    const unsubscribe = bridge.subscribe(projectId, {
      onOpen: () => {
        setLive("live");
        if (opened) void syncAll();
        opened = true;
      },
      onError: () => setLive("reconnecting"),
      onEvent: (event) => {
        dispatch({ type: "event", event });
        if (event.type === "project.updated") setProject(event.project);
        if (event.type === "message.steered") setSteered((s) => [...s, event.text]);
        if (event.type === "conversation.rewound") {
          dispatch({ type: "rewound", messageId: event.message_id, label: rewoundLabel(false), at: new Date().toISOString(), soft: true });
          void syncAll();
        }
        // The client's reducer keeps only the position of a compaction; a manual one also carries its label and size.
        if (event.type === "agent.compacted" && event.manual) {
          const { type: _type, seq: _seq, agent_id: agentId, ...marker } = event;
          dispatch({ type: "compactions", agentId, markers: [{ ...marker, label: "history compacted" }] });
        }
        if (event.type === "turn.finished" || event.type === "project.updated") void refreshProjects();
        for (const observe of observers.current) observe(event);
      },
    });
    void syncAll();
    return unsubscribe;
  }, [bridge, projectId, syncAll, refreshProjects]);

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

  const orchestrator = project ? state.agents[project.orchestrator_agent_id] : undefined;
  const running = orchestrator?.status === "running" || (project?.status === "running" && !orchestrator);

  const value = useMemo<ProjectValue>(
    () => ({
      projectId,
      project,
      loadError,
      state,
      live,
      running,
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
      steered,
      applyRewind: (messageId, label) => dispatch({ type: "rewound", messageId, label, at: new Date().toISOString() }),
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
      onEvent: (listener) => {
        observers.current.add(listener);
        return () => {
          observers.current.delete(listener);
        };
      },
    }),
    [projectId, project, loadError, state, live, running, syncAll, fetchMessages, bridge, refreshProjects, steered],
  );

  return <ProjectContextProvider value={value}>{children}</ProjectContextProvider>;
}
