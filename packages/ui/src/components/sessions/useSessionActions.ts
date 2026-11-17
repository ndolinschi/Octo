import type { MoveToWorktreeInput, NewSessionInput, ProjectSession, SessionMessageResult } from "@octo/agent-client";
import { useCallback, useMemo, useState } from "react";
import { useLatest } from "../../lib/hooks";
import { deleteSessionCleanly } from "../../lib/sessions/deleteSession";
import { failureText } from "../../lib/sessions/model";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { sessionTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";

export { failureText };

/**
 * What a person can do to a session, each as one call that records its failure in `error` (shown as a `Notice` by the view
 * that owns the hook) and resolves with the result, or undefined when it failed. The sessions list itself is kept by the
 * `session.*` events in `state.sessions`; nothing here updates it.
 */
export function useSessionActions() {
  const { bridge } = useApp();
  const { projectId, applySession, state } = useProject();
  const ws = useOptionalWorkspace();
  const wsRef = useLatest(ws);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(async <T>(what: string, call: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setBusy(what);
    try {
      return await call();
    } catch (e) {
      setError(failureText(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  const listRef = useLatest(state.sessions.list);
  const currentId = useLatest(state.sessions.currentId);
  const defaultIdRef = useLatest(state.sessions.defaultId);
  const changed = useCallback(
    (what: string, call: () => Promise<ProjectSession>) =>
      run(what, async () => {
        const session = await call();
        applySession({ kind: "upsert", session });
        return session;
      }),
    [run, applySession],
  );

  const api = useMemo(() => {
    const need = <T>(method: T | undefined): T => {
      if (method === undefined) throw new Error("This version of Octo's local service does not support sessions.");
      return method;
    };
    return {
      /** A new main session (parallel sessions: not the default unless `make_default`; nothing else changes). */
      create: (input?: NewSessionInput) =>
        run("create", async () => {
          const { session } = await bridge.createSession(projectId, input);
          applySession({ kind: "upsert", session });
          if (session.default ?? session.current) applySession({ kind: "current", id: session.id, previous: currentId.current ?? "" });
          return session;
        }),
      /** Makes a main session the default: where unaddressed messages go (decision 96; "Resume" before parallel sessions). */
      makeDefault: (sid: string) =>
        run("resume", async () => {
          const session = await bridge.setDefaultSession(projectId, sid);
          applySession({ kind: "upsert", session });
          if (currentId.current !== sid) applySession({ kind: "current", id: sid, previous: currentId.current ?? "" });
          return session;
        }),
      rename: (sid: string, title: string) => changed("rename", () => need(bridge.patchSession).call(bridge, projectId, sid, { title })),
      archive: (sid: string, archived: boolean) => changed("archive", () => need(bridge.patchSession).call(bridge, projectId, sid, { archived })),
      remove: (sid: string) =>
        run("delete", async () => {
          const target = listRef.current.find((s) => s.id === sid) ?? { id: sid, kind: "main" as const, state: "idle" as const };
          const res = await deleteSessionCleanly(bridge, projectId, target, listRef.current);
          if (res.createdSession) applySession({ kind: "upsert", session: res.createdSession });
          if (res.replacementId) applySession({ kind: "current", id: res.replacementId, previous: sid });
          const children = listRef.current.filter((s) => s.parent_session_id === sid).map((s) => s.id);
          applySession({ kind: "remove", ids: [sid, ...children] });
          const curWs = wsRef.current;
          if (curWs) {
            curWs.dropTab(sessionTab(sid));
            const shownChat = curWs.chatSessionId ?? defaultIdRef.current;
            const nextId = res.replacementId ?? listRef.current.find((s) => s.id !== sid && s.kind === "main" && !s.archived)?.id ?? null;
            if (shownChat === sid && nextId) curWs.showSession(nextId);
          }
          return true;
        }),
      stop: (sid: string) => changed("stop", () => bridge.stopSession(projectId, sid)),
      moveToWorktree: (sid: string, input?: MoveToWorktreeInput) =>
        run("worktree", async () => {
          const result = await need(bridge.moveSessionToWorktree).call(bridge, projectId, sid, input);
          applySession({ kind: "upsert", session: result.session });
          return result;
        }),
      message: (sid: string, text: string, reportToParent: boolean): Promise<SessionMessageResult | undefined> =>
        run("message", async () => {
          const sent = await need(bridge.messageSession).call(bridge, projectId, sid, text, { reportToParent });
          applySession({ kind: "upsert", session: sent.session });
          return sent;
        }),
    };
  }, [bridge, projectId, run, changed, applySession, listRef, currentId, defaultIdRef, wsRef]);

  return { ...api, error, busy, clear: () => setError(null) };
}

export type SessionActions = ReturnType<typeof useSessionActions>;
