import type { Bridge } from "@octo/agent-client";
import { providersSnapshot, refreshProviders } from "./useProviders";

/** The one dim line next to "Use anyway" (decision 2026-11-12: the login probe is advisory, never a lock). */
export const USE_ANYWAY_NOTE = "Octo could not confirm the login. If the agent is logged out, the next request will fail with its own message.";

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

/** A refusal (422 `model_unavailable`) the user may override: the harness says the login probe alone decided it. */
export function canForce(e: unknown): boolean {
  return typeof e === "object" && e !== null && "can_force" in e && e.can_force === true;
}

/** The agent a refusal is about (`BridgeError.provider`), when it is one the user can recheck. */
export function refusedProvider(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "provider" in e && typeof e.provider === "string" ? e.provider : undefined;
}
