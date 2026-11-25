import type { Bridge } from "@octo/agent-client";
import { focusSoon, visibleComposer } from "../focus";
import { navigate } from "../route";

/** Creates a main session directly, opens it in the active workspace or switches route, and focuses the composer. */
export async function createAndOpenSession(
  bridge: Pick<Bridge, "createSession">,
  projectId: string,
  opts?: {
    openInWorkspace?: ((sessionId: string) => void) | undefined;
    refreshSessions?: (() => void) | undefined;
  },
): Promise<string> {
  const prevComposer = visibleComposer();
  const { session } = await bridge.createSession(projectId, {});
  opts?.refreshSessions?.();
  if (opts?.openInWorkspace) opts.openInWorkspace(session.id);
  else navigate(projectId, null, session.id);
  focusSoon(
    prevComposer
      ? () => {
          const el = visibleComposer();
          return el && el !== prevComposer ? el : null;
        }
      : visibleComposer,
    { timeout: 3000 },
  );
  return session.id;
}
