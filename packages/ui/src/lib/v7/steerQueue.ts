import type { ProjectMode } from "@octo/agent-client";

/** Parity B6: steering a queued message into the running turn (the queue's own chunk; `steer.ts` has what the transcript needs). */

/** An ACP orchestrator cannot take a message mid-turn (409 `steer_unsupported`); the built-in loop can. */
export function steerUnsupportedFor(orchestratorModel: string | undefined): boolean {
  return (orchestratorModel ?? "").startsWith("acp:");
}

export const STEER_REASON = "This agent can't take a message while it works. It sends when the agent finishes, or stop it and send now.";

/** The reply to a steer attempt, from the error's code. */
export function steerOutcome(code: string | null): "unsupported" | "gone" | "failed" {
  if (code === "steer_unsupported") return "unsupported";
  if (code === "not_found") return "gone";
  return "failed";
}

/** The tag a queued row carries when its message was written in a read-only mode. */
export function queuedModeTag(mode: ProjectMode | undefined): string | null {
  return mode === "ask" ? "Ask" : mode === "plan" ? "Plan" : null;
}
