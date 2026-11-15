import { useCallback } from "react";
import { errorMessage } from "../../lib/format";
import { hrefFor, navigate } from "../../lib/route";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { sessionTab } from "../../state/workspace/layout";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { prefillComposer } from "./composerDraft";

/** What the composer shows after `/new <text>`: a quiet line under the field with a link to the new session. */
export type StartedSession = { title: string; href: string; waiting: boolean };

/**
 * Addition 9: `/new <text>` starts a new main session of this project and sends the text there; the view stays where it is
 * and the current session neither gets the text nor stops. `/new` alone opens the new, empty session. Returns what the
 * composer shows (`started`), or the error to keep the text with (`failed`); a send that failed after the session was
 * created opens the new session with the text in its box.
 */
export function useNewSession() {
  const { bridge } = useApp();
  const { projectId } = useProject();
  const activity = useActivity();
  const ws = useOptionalWorkspace();
  return useCallback(
    async (text: string, attachments: readonly string[]): Promise<{ started: StartedSession } | { failed: string } | null> => {
      // Its own small chunk, loaded with the first `/new` (the composer is in the entry chunk).
      const { runNewSession } = await import("../../lib/newSession");
      const out = await runNewSession(
        {
          create: (input) => bridge.createSession(projectId, input),
          send: (sid, body, att) => bridge.sendSessionMessage(projectId, sid, body, att.length ? { attachments: [...att] } : undefined),
        },
        text,
        attachments,
      );
      switch (out.kind) {
        case "create-failed":
          return { failed: `The session was not created: ${errorMessage(out.error).replace(/\.$/, "")}. Your text is still here; try again.` };
        case "open":
          activity.refreshSessions();
          navigate(projectId, null, out.sessionId);
          return null;
        case "send-failed":
          // Nothing is lost: the new session opens with the request in its box, to send again.
          if (ws) prefillComposer(ws.memory, sessionTab(out.sessionId), text);
          activity.refreshSessions();
          navigate(projectId, null, out.sessionId);
          return null;
        case "started":
          activity.refreshSessions();
          return { started: { title: out.title, href: hrefFor(projectId, null, out.sessionId), waiting: out.waiting } };
      }
    },
    [bridge, projectId, activity, ws],
  );
}
