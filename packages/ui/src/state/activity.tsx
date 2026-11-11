import type { Agent, Bridge, Message, Plugin, ProjectSummary } from "@octo/agent-client";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useApp } from "./app";
import { createRequiredContext } from "../lib/context";

/** At most this many bridge reads in flight for the overview data (Details files, Home). */
const MAX_IN_FLIGHT = 4;

/** A small FIFO limiter: `run` resolves with the task's result once a slot is free. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = () => {
        this.active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };
      if (this.active < this.max) go();
      else this.queue.push(go);
    });
  }
}

type Cached<T> = { stamp: string; promise: Promise<T>; value?: T };

/**
 * Session cache for data that only the overview surfaces need: an agent's stored transcript (keyed by its
 * `finished_at`, so a finished agent is read once; a running one again after `invalidate`) and a project's
 * agent list (keyed by the project's `updated_at`). Everything goes through one limiter (4 in flight).
 */
export class ActivityStore {
  private limiter = new Limiter(MAX_IN_FLIGHT);
  private transcripts = new Map<string, Cached<Message[]>>();
  private agents = new Map<string, Cached<Agent[]>>();
  private live = new Map<string, number>();
  /** The open project's agents as its live subscription sees them (newer than any cached list). */
  private open = new Map<string, Agent[]>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(private bridge: Bridge) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getVersion = () => this.version;
  private changed() {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  /** A running agent's transcript is read again on the next request (its files changed). */
  invalidate(projectId: string) {
    this.live.set(projectId, (this.live.get(projectId) ?? 0) + 1);
    this.changed();
  }

  transcript(projectId: string, agent: Agent): Promise<Message[]> {
    const key = `${projectId}/${agent.id}`;
    const stamp = agent.finished_at ?? `live:${this.live.get(projectId) ?? 0}:${agent.status}`;
    const hit = this.transcripts.get(key);
    if (hit?.stamp === stamp) return hit.promise;
    const entry: Cached<Message[]> = { stamp, promise: this.limiter.run(() => this.bridge.listMessages(projectId, agent.id)) };
    entry.promise.then(
      (v) => {
        entry.value = v;
      },
      () => this.transcripts.delete(key),
    );
    this.transcripts.set(key, entry);
    return entry.promise;
  }

  /** Synchronous peek (already loaded for this stamp). */
  peekTranscript(projectId: string, agent: Agent): Message[] | undefined {
    const hit = this.transcripts.get(`${projectId}/${agent.id}`);
    const stamp = agent.finished_at ?? `live:${this.live.get(projectId) ?? 0}:${agent.status}`;
    return hit?.stamp === stamp ? hit.value : undefined;
  }

  agentsOf(project: ProjectSummary): Promise<Agent[]> {
    const hit = this.agents.get(project.id);
    if (hit?.stamp === project.updated_at) return hit.promise;
    const entry: Cached<Agent[]> = { stamp: project.updated_at, promise: this.limiter.run(() => this.bridge.listAgents(project.id)) };
    entry.promise.then(
      (v) => {
        entry.value = v;
        this.changed();
      },
      () => this.agents.delete(project.id),
    );
    this.agents.set(project.id, entry);
    return entry.promise;
  }

  /** The open project publishes its live agents (null when it closes), so the sidebar and Home read them first. */
  setLiveAgents(projectId: string, agents: Agent[] | null) {
    if (agents) this.open.set(projectId, agents);
    else this.open.delete(projectId);
    this.changed();
  }
  liveAgents(projectId: string): Agent[] | undefined {
    return this.open.get(projectId);
  }

  /** Synchronous peek at a project's cached agent list for its current `updated_at`. */
  peekAgents(project: ProjectSummary): Agent[] | undefined {
    const hit = this.agents.get(project.id);
    return hit?.stamp === project.updated_at ? hit.value : undefined;
  }

  private pluginList: Promise<Plugin[]> | null = null;
  /** The plugin manifests, read once per session (they change only when the harness restarts). */
  plugins(): Promise<Plugin[]> {
    this.pluginList ??= this.bridge.listPlugins().catch((e: unknown) => {
      this.pluginList = null;
      throw e;
    });
    return this.pluginList;
  }

  /** Runs any other bridge read under the same limit. */
  limit<T>(task: () => Promise<T>): Promise<T> {
    return this.limiter.run(task);
  }
}

export const { Provider: ActivityContextProvider, useRequired: useActivity } = createRequiredContext<ActivityStore>("useActivity");

export function ActivityProvider({ children }: { children: ReactNode }) {
  const { bridge } = useApp();
  const store = useMemo(() => new ActivityStore(bridge), [bridge]);
  return <ActivityContextProvider value={store}>{children}</ActivityContextProvider>;
}

/** Re-renders when the store says something was invalidated. */
export function useActivityVersion(store: ActivityStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

/** Calls `effect` once per change of `key` with an abort flag (for async loads in effects). */
export function useAsync(effect: (cancelled: () => boolean) => void, deps: unknown[]) {
  useEffect(() => {
    let stop = false;
    effect(() => stop);
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
