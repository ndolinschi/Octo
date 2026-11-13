import { BridgeError, type ProjectSession, type SessionMessageResult } from "@octo/agent-client";
import { useCallback, useMemo, useState } from "react";
import { useLatest } from "../../lib/hooks";
import { isStructured } from "../../lib/errors/plain";
import { errorMessage, structuredError } from "../../lib/format";
import { sessionErrorText } from "../../lib/sessions/model";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

/**
 * A refusal in plain words. A harness of decision 94b sends `message` (and `hint`) itself: those win. The fixed texts by code
 * (`sessions.md`) are only the fallback for an older harness; anything else is the shared error text.
 */
export function failureText(e: unknown): string {
  if (!(e instanceof BridgeError)) return `${errorMessage(e)} Try again.`;
  const fields = structuredError(e);
  if (isStructured(fields)) {
    const sentence = /[.!?]$/.test(fields.message) ? fields.message : `${fields.message}.`;
    return fields.hint ? `${sentence} ${fields.hint.replace(/`/g, "")}` : sentence;
  }
  return sessionErrorText(e.code, e.message);
}

/**
 * What a person can do to a session, each as one call that records its failure in `error` (shown as a `Notice` by the view
 * that owns the hook) and resolves with the result, or undefined when it failed. The sessions list itself is kept by the
 * `session.*` events in `state.sessions`; nothing here updates it.
 */
export function useSessionActions() {
  const { bridge } = useApp();
  const { projectId, applySession, state } = useProject();
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
      if (method === undefined) throw new Error("This harness does not support sessions.");
      return method;
    };
    return {
      create: () =>
        run("create", async () => {
          const session = await need(bridge.createSession).call(bridge, projectId);
          applySession({ kind: "upsert", session });
          applySession({ kind: "current", id: session.id, previous: currentId.current ?? "" });
          return session;
        }),
      resume: (sid: string) =>
        run("resume", async () => {
          const session = await need(bridge.resumeSession).call(bridge, projectId, sid);
          applySession({ kind: "upsert", session });
          if (currentId.current !== sid) applySession({ kind: "current", id: sid, previous: currentId.current ?? "" });
          return session;
        }),
      rename: (sid: string, title: string) => changed("rename", () => need(bridge.patchSession).call(bridge, projectId, sid, { title })),
      archive: (sid: string, archived: boolean) => changed("archive", () => need(bridge.patchSession).call(bridge, projectId, sid, { archived })),
      remove: (sid: string) =>
        run("delete", async () => {
          await need(bridge.deleteSession).call(bridge, projectId, sid);
          const children = listRef.current.filter((s) => s.parent_session_id === sid).map((s) => s.id);
          applySession({ kind: "remove", ids: [sid, ...children] });
          return true;
        }),
      stop: (sid: string) => changed("stop", () => need(bridge.stopSession).call(bridge, projectId, sid)),
      message: (sid: string, text: string, reportToParent: boolean): Promise<SessionMessageResult | undefined> =>
        run("message", async () => {
          const sent = await need(bridge.messageSession).call(bridge, projectId, sid, text, { reportToParent });
          applySession({ kind: "upsert", session: sent.session });
          return sent;
        }),
    };
  }, [bridge, projectId, run, changed, applySession, listRef, currentId]);

  return { ...api, error, busy, clear: () => setError(null) };
}

export type SessionActions = ReturnType<typeof useSessionActions>;
