import type { Bridge, ProjectSummary } from "@octo/agent-client";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { requestTitle } from "../lib/comments";
import { latestReply, promptText } from "../lib/transcript";
import { Limiter } from "./activity";
import { useApp } from "./app";
import { errorMessage } from "../lib/format";
import { createRequiredContext } from "../lib/context";

/** One user message of a project's orchestrator thread. */
export type Request = { id: number; text: string; created_at: string };

/** The first line of the orchestrator's latest reply (Home, decision 23). */
export type Reply = { text: string; at: string };

type Entry = { updatedAt: string; requests: Request[] | null; reply: Reply | null; error: string | null; loading: boolean };

/**
 * Lazily loaded, cached request lists per project (newest first) and the orchestrator's latest reply, for the
 * palette and Home. An entry is refetched only when the project's `updated_at` moves on.
 */
class RequestStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private orchestrators = new Map<string, string>();
  /** Home asks for every project at once: at most 4 loads in flight. */
  private limiter = new Limiter(4);
  constructor(private bridge: Bridge) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  get = (projectId: string) => this.entries.get(projectId);
  private changes = 0;
  version = () => this.changes;

  private set(projectId: string, entry: Entry) {
    this.entries.set(projectId, entry);
    this.changes += 1;
    for (const l of this.listeners) l();
  }

  ensure(project: ProjectSummary) {
    const current = this.entries.get(project.id);
    if (current && (current.updatedAt === project.updated_at || current.loading)) return;
    this.set(project.id, { updatedAt: project.updated_at, requests: current?.requests ?? null, reply: current?.reply ?? null, error: null, loading: true });
    void this.load(project);
  }

  private load(project: ProjectSummary): Promise<void> {
    return this.limiter.run(() => this.read(project));
  }

  private async read(project: ProjectSummary) {
    try {
      let orchestrator = this.orchestrators.get(project.id);
      if (!orchestrator) {
        orchestrator = (await this.bridge.getProject(project.id)).orchestrator_agent_id;
        this.orchestrators.set(project.id, orchestrator);
      }
      const messages = await this.bridge.listMessages(project.id, orchestrator);
      const requests = messages
        .filter((m) => m.role === "user")
        .map((m) => ({ id: m.id, text: requestTitle(promptText(m)).trim(), created_at: m.created_at }))
        .filter((r) => r.text)
        .reverse();
      this.set(project.id, { updatedAt: project.updated_at, requests, reply: latestReply(messages), error: null, loading: false });
    } catch (e) {
      const prev = this.entries.get(project.id);
      this.set(project.id, {
        updatedAt: "",
        requests: prev?.requests ?? null,
        reply: prev?.reply ?? null,
        error: errorMessage(e),
        loading: false,
      });
    }
  }
}

const { Provider: RequestsContextProvider, useRequired: useRequestStore } = createRequiredContext<RequestStore>("useRequestStore");

export function RequestsProvider({ children }: { children: ReactNode }) {
  const { bridge } = useApp();
  const store = useMemo(() => new RequestStore(bridge), [bridge]);
  return <RequestsContextProvider value={store}>{children}</RequestsContextProvider>;
}

/** Several projects' requests and latest replies at once (Home), loading every one of them; entries are null until loaded. */
export function useAllRequests(projects: ProjectSummary[] | null): Map<string, { requests: Request[]; reply: Reply | null } | null> {
  const store = useRequestStore();
  const version = useSyncExternalStore(store.subscribe, store.version);
  useEffect(() => {
    for (const p of projects ?? []) store.ensure(p);
  }, [projects, store]);
  return useMemo(() => {
    void version;
    return new Map(
      (projects ?? []).map((p) => {
        const e = store.get(p.id);
        return [p.id, e?.requests ? { requests: e.requests, reply: e.reply } : null];
      }),
    );
  }, [projects, store, version]);
}

/** The project's requests, loading them while `enabled`. Null until the first load finishes. */
export function useRequests(project: ProjectSummary | undefined, enabled: boolean) {
  const store = useRequestStore();
  const entry = useSyncExternalStore(store.subscribe, () => (project ? store.get(project.id) : undefined));
  useEffect(() => {
    if (enabled && project) store.ensure(project);
  }, [enabled, project, store]);
  return { requests: entry?.requests ?? null };
}
