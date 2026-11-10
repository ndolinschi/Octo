import type { Bridge, ProjectSummary } from "@octo/agent-client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { promptText } from "../lib/transcript";
import { useApp } from "./app";

/** One user message of a project's orchestrator thread. */
export type Request = { id: number; text: string; created_at: string };

type Entry = { updatedAt: string; requests: Request[] | null; error: string | null; loading: boolean };

/**
 * Lazily loaded, cached request lists per project (newest first). An entry is refetched only
 * when the project's `updated_at` moves on, so expanded sidebar rows follow live activity.
 */
class RequestStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private orchestrators = new Map<string, string>();
  constructor(private bridge: Bridge) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  get = (projectId: string) => this.entries.get(projectId);

  private set(projectId: string, entry: Entry) {
    this.entries.set(projectId, entry);
    for (const l of this.listeners) l();
  }

  /** Loads again now (after "Couldn't load"), whatever the cached `updated_at` says. */
  retry(project: ProjectSummary) {
    const current = this.entries.get(project.id);
    if (current?.loading) return;
    this.set(project.id, { updatedAt: project.updated_at, requests: current?.requests ?? null, error: null, loading: true });
    void this.load(project);
  }

  ensure(project: ProjectSummary) {
    const current = this.entries.get(project.id);
    if (current && (current.updatedAt === project.updated_at || current.loading)) return;
    this.set(project.id, { updatedAt: project.updated_at, requests: current?.requests ?? null, error: null, loading: true });
    void this.load(project);
  }

  private async load(project: ProjectSummary) {
    try {
      let orchestrator = this.orchestrators.get(project.id);
      if (!orchestrator) {
        orchestrator = (await this.bridge.getProject(project.id)).orchestrator_agent_id;
        this.orchestrators.set(project.id, orchestrator);
      }
      const messages = await this.bridge.listMessages(project.id, orchestrator);
      const requests = messages
        .filter((m) => m.role === "user")
        .map((m) => ({ id: m.id, text: promptText(m).trim(), created_at: m.created_at }))
        .filter((r) => r.text)
        .reverse();
      this.set(project.id, { updatedAt: project.updated_at, requests, error: null, loading: false });
    } catch (e) {
      const prev = this.entries.get(project.id);
      this.set(project.id, {
        updatedAt: "",
        requests: prev?.requests ?? null,
        error: e instanceof Error ? e.message : String(e),
        loading: false,
      });
    }
  }
}

const StoreContext = createContext<RequestStore | null>(null);

export function RequestsProvider({ children }: { children: ReactNode }) {
  const { bridge } = useApp();
  const store = useMemo(() => new RequestStore(bridge), [bridge]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The project's requests, loading them while `enabled`. Null until the first load finishes. */
export function useRequests(project: ProjectSummary | undefined, enabled: boolean) {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useRequests outside RequestsProvider");
  const entry = useSyncExternalStore(store.subscribe, () => (project ? store.get(project.id) : undefined));
  useEffect(() => {
    if (enabled && project) store.ensure(project);
  }, [enabled, project, store]);
  return {
    requests: entry?.requests ?? null,
    error: entry?.error ?? null,
    retry: () => {
      if (project) store.retry(project);
    },
  };
}
