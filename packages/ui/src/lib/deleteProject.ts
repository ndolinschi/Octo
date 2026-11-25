import type { Bridge } from "@octo/agent-client";

/**
 * Deletes a project cleanly even when a session or turn is running or waiting for approval:
 * stops active turns/sessions best-effort and requests forced deletion (`?force=1`).
 */
export async function deleteProjectCleanly(bridge: Bridge, projectId: string): Promise<void> {
  await bridge.cancelTurn(projectId).catch(() => undefined);
  if (bridge.listSessions) {
    const sessions = await bridge.listSessions(projectId, { archived: "all", limit: 200 }).catch(() => []);
    for (const s of sessions) {
      if (s.state === "working" || s.state === "waiting") {
        await bridge.stopSession(projectId, s.id).catch(() => undefined);
      }
    }
  }
  await bridge.deleteProject(projectId, { force: true });
}
