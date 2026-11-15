import type { Bridge } from "@octo/agent-client";
import { providersSnapshot, refreshProviders } from "./useProviders";

/** The one dim line next to "Use anyway" (decision 2026-11-12: the login probe is advisory, never a lock). */
export const USE_ANYWAY_NOTE = "Octo could not confirm the login. If the agent is logged out, your next request will fail.";

/**
 * "Check again": the harness runs the agent's login probe now (`POST /v1/providers/{id}/recheck`), then the shared list is
 * reloaded. An older harness has no endpoint: the list is just reloaded. True when the agent reads as ready afterwards.
 */
export async function recheckAgent(bridge: Bridge, agentId: string): Promise<boolean> {
  const answered = bridge.recheckProvider ? await bridge.recheckProvider(agentId) : null;
  await refreshProviders(bridge);
  if (answered) return answered.state === "ready";
  return providersSnapshot(bridge)?.providers.some((p) => p.id === agentId && p.state === "ready") === true;
}

export { canForce, refusedProvider } from "./refusal";
