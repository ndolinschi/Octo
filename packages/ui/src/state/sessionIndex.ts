import { retryDelay, type GlobalSession, type ProjectSummary } from "@octo/agent-client";
import { withDeadline } from "../lib/deadline";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "./app";
import { useActivity, useActivityVersion, type ActivityStore } from "./activity";

/** The last `listAllSessions` read per activity store (shared by the sidebar, Home and the palette), and its key. */
const reads = new WeakMap<ActivityStore, { key: string; promise: Promise<GlobalSession[]>; value?: GlobalSession[] }>();

export type SessionIndex = {
  /** Each project's main sessions (the open project's live from its stream), by project id. */
  byProject: ReadonlyMap<string, readonly GlobalSession[]>;
  /** Every project's main sessions, newest activity first. */
  all: readonly GlobalSession[];
  /** The list has been read once (until then the tree shows its projects only). */
  loaded: boolean;
};

const byActivity = (a: GlobalSession, b: GlobalSession) =>
  a.last_activity_at < b.last_activity_at ? 1 : a.last_activity_at > b.last_activity_at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Parallel sessions (decision 96): the sessions the sidebar, Home and the palette list. Rows of projects that are not open
 * come from `listAllSessions` (re-read when a project's `updated_at` moves, as `useOrchestrators` does with agents); the
 * open project's rows are its live list (`setLiveSessions`).
 */
export function useSessionIndex(projects: readonly ProjectSummary[] | null): SessionIndex {
  const { bridge } = useApp();
  const store = useActivity();
  const version = useActivityVersion(store);
  const [, setRead] = useState(0);
  // P2-4: failed reads in a row; a failed read is tried again after 1–30 s (the load retry's policy).
  const [failed, setFailed] = useState(0);
  const key = `${(projects ?? []).map((p) => `${p.id}:${p.updated_at}`).join(",")}#${store.sessionsRound}`;
  useEffect(() => {
    if (projects === null) return;
    const hit = reads.get(store);
    if (hit?.key === key) return;
    const entry: { key: string; promise: Promise<GlobalSession[]>; value?: GlobalSession[] } = {
      key,
      promise: store.limit(() => withDeadline(bridge.listAllSessions({ kind: "main", limit: 200 }))),
    };
    if (hit?.value) entry.value = hit.value;
    reads.set(store, entry);
    entry.promise.then(
      (v) => {
        entry.value = v;
        setFailed(0);
        setRead((n) => n + 1);
      },
      // A list that cannot be read keeps the last one, and is read again after a while (or at the next change of a project).
      // (The timer is not cleared with the effect: the project list is polled, and each poll would cancel it.)
      () => {
        window.setTimeout(
          () => {
            if (reads.get(store) !== entry) return;
            reads.set(store, { ...entry, key: "" });
            setFailed((n) => n + 1);
          },
          retryDelay(failed + 1),
        );
      },
    );
  }, [store, bridge, key, projects, failed]);
  const read = reads.get(store)?.value;
  return useMemo(() => {
    void version;
    const names = new Map((projects ?? []).map((p) => [p.id, p.name]));
    const byProject = new Map<string, GlobalSession[]>();
    for (const s of read ?? []) {
      if (!names.has(s.project_id)) continue;
      let list = byProject.get(s.project_id);
      if (!list) byProject.set(s.project_id, (list = []));
      list.push(s);
    }
    for (const [id, name] of names) {
      const live = store.liveSessions(id);
      if (live)
        byProject.set(
          id,
          live.filter((s) => s.kind === "main").map((s) => ({ ...s, project_id: id, project_name: name })),
        );
    }
    const all = [...byProject.values()].flat().sort(byActivity);
    return { byProject, all, loaded: read !== undefined || failed > 0 };
  }, [store, version, projects, read, failed]);
}
