import { emptyProjectState, type BridgeEvent, type Project, type ProjectInput, type ProjectState } from "@octo/agent-client";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useApp } from "./app";
import { projectReducer } from "./projectReducer";

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
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  update(patch: Partial<ProjectInput>): Promise<Project>;
  createNote(input: { title: string; content: string }): Promise<void>;
  updateNote(id: string, patch: { title?: string; content?: string }): Promise<void>;
  deleteNote(id: string): Promise<void>;
  /** Observe raw bridge events on this project's existing subscription (no extra connection). */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
};

const ProjectContext = createContext<ProjectValue | null>(null);

export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const { bridge, refreshProjects } = useApp();
  const [state, dispatch] = useReducer(projectReducer, undefined, emptyProjectState);
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const loaded = useRef(new Set<string>());
  const observers = useRef(new Set<(event: BridgeEvent) => void>());

  const fetchMessages = useCallback(
    async (agentId: string) => {
      loaded.current.add(agentId);
      try {
        dispatch({ type: "messages", agentId, messages: await bridge.listMessages(projectId, agentId) });
      } catch {
        loaded.current.delete(agentId);
      }
    },
    [bridge, projectId],
  );

  const syncAll = useCallback(async () => {
    try {
      const [p, agents, notes] = await Promise.all([bridge.getProject(projectId), bridge.listAgents(projectId), bridge.listNotes(projectId)]);
      setProject(p);
      setLoadError(null);
      dispatch({ type: "agents", agents });
      dispatch({ type: "notes", notes });
      const ids = new Set([p.orchestrator_agent_id, ...loaded.current]);
      await Promise.all([...ids].map(fetchMessages));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
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
        if (event.type === "turn.finished" || event.type === "project.updated") void refreshProjects();
        for (const observe of observers.current) observe(event);
      },
    });
    void syncAll();
    return unsubscribe;
  }, [bridge, projectId, syncAll, refreshProjects]);

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
      send: async (text) => {
        dispatch({ type: "clearTurn" });
        const message = await bridge.sendMessage(projectId, text);
        dispatch({ type: "messages", agentId: message.agent_id, messages: [message] });
        void refreshProjects();
      },
      cancel: () => bridge.cancelTurn(projectId),
      update: async (patch) => {
        const next = await bridge.updateProject(projectId, patch);
        setProject(next);
        void refreshProjects();
        return next;
      },
      createNote: async (input) => {
        const note = await bridge.createNote(projectId, input);
        dispatch({ type: "notes", notes: [...state.notes.filter((n) => n.id !== note.id), note] });
      },
      updateNote: async (id, patch) => {
        const note = await bridge.updateNote(projectId, id, patch);
        dispatch({ type: "notes", notes: state.notes.map((n) => (n.id === id ? note : n)) });
      },
      deleteNote: async (id) => {
        await bridge.deleteNote(projectId, id);
        dispatch({ type: "notes", notes: state.notes.filter((n) => n.id !== id) });
      },
      onEvent: (listener) => {
        observers.current.add(listener);
        return () => {
          observers.current.delete(listener);
        };
      },
    }),
    [projectId, project, loadError, state, live, running, syncAll, fetchMessages, bridge, refreshProjects],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject outside ProjectProvider");
  return ctx;
}
