import { BridgeError, type Bridge, type ProjectSession } from "@octo/agent-client";

export type DeleteSessionTarget = Pick<ProjectSession, "id" | "kind" | "state"> & {
  default?: boolean | undefined;
  current?: boolean | undefined;
};

export type DeleteSessionResult = {
  /** Replacement main session ID promoted (or freshly created) when deleting the default main session. */
  replacementId: string | null;
  /** Freshly created main session when the deleted session was the project's only main session. */
  createdSession: ProjectSession | null;
};

/**
 * Deletes any main or agent session cleanly:
 * 1. Stops any working/waiting child agent sessions and the session itself.
 * 2. When deleting the project's default/current main session, promotes another main session
 *    (or creates a fresh empty default session when deleting the last main session) first.
 * 3. Calls `bridge.deleteSession` and retries once if a race reports `current_session` or `session_running`.
 */
export async function deleteSessionCleanly(
  bridge: Bridge,
  projectId: string,
  target: DeleteSessionTarget,
  knownSessions?: readonly ProjectSession[],
): Promise<DeleteSessionResult> {
  const del = bridge.deleteSession;
  if (!del) throw new Error("This version of Octo's local service does not support deleting sessions.");

  const loadAll = async (): Promise<ProjectSession[]> => {
    if (bridge.listSessions) {
      const fetched = await bridge.listSessions(projectId, { archived: "all", limit: 200 }).catch(() => null);
      if (fetched) return fetched;
    }
    return knownSessions ? [...knownSessions] : [];
  };

  let all = knownSessions ? [...knownSessions] : await loadAll();

  const stopActive = async (list: readonly ProjectSession[]) => {
    if (target.kind === "main") {
      for (const child of list) {
        if (child.kind === "agent" && child.parent_session_id === target.id && (child.state === "working" || child.state === "waiting")) {
          await bridge.stopSession(projectId, child.id).catch(() => undefined);
        }
      }
    }
    const self = list.find((s) => s.id === target.id);
    const state = self?.state ?? target.state;
    if (state === "working" || state === "waiting") {
      await bridge.stopSession(projectId, target.id).catch(() => undefined);
    }
  };

  let replacementId: string | null = null;
  let createdSession: ProjectSession | null = null;

  const promoteReplacement = async () => {
    all = await loadAll();
    const mains = all.filter((s) => s.kind === "main" && s.id !== target.id);
    const nextMain = mains.find((s) => !s.archived) ?? mains[0];
    if (nextMain) {
      await bridge.setDefaultSession(projectId, nextMain.id);
      replacementId = nextMain.id;
      return;
    }
    const { session: fresh } = await bridge.createSession(projectId, {});
    createdSession = fresh;
    if (!(fresh.default ?? fresh.current)) {
      createdSession = await bridge.setDefaultSession(projectId, fresh.id);
    }
    replacementId = createdSession.id;
  };

  await stopActive(all);
  if (target.kind === "main" && (target.default ?? target.current)) {
    await promoteReplacement();
  }

  try {
    await del.call(bridge, projectId, target.id);
  } catch (err) {
    if (err instanceof BridgeError && err.code === "current_session" && target.kind === "main") {
      await promoteReplacement();
      await del.call(bridge, projectId, target.id);
    } else if (err instanceof BridgeError && err.code === "session_running") {
      await stopActive(await loadAll());
      await del.call(bridge, projectId, target.id);
    } else {
      throw err;
    }
  }

  return { replacementId, createdSession };
}
