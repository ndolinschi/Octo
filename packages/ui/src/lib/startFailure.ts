import type { Agent, TurnOutcome } from "@octo/agent-client";
import { turnWarning } from "./turnEnding";

/**
 * Its own module: only the lazy empty-project chunks read it, so it stays out of the entry (bundle budget).
 *
 * Why the orchestrator failed before anything was stored (an ACP agent that is not logged in): the last turn's error, else
 * the agent's own; undefined when it did not fail, or while it runs again. `StartFailure` shows it; the empty project's title
 * then leaves out its own "provider is not connected" sentence (one problem, said once).
 */
export function startFailureOf(lastTurn: TurnOutcome | null, agent: Pick<Agent, "status" | "error">): string | null | undefined {
  if (agent.status === "running") return undefined;
  if (lastTurn?.status === "failed") return lastTurn.error;
  return agent.status === "failed" || (agent.error && !turnWarning(agent.error)) ? agent.error : undefined;
}
