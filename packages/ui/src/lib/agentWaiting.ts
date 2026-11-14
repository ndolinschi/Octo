import type { Approval, InputRequest } from "@octo/agent-client";

/**
 * NEW-3: what an agent waits on from the person — a pending approval (it blocks a tool call) wins over an open form; null
 * when nothing waits. Waiting wins over working in an agent's row, as it does for the project (`lib/orchestrator.ts`).
 */
export type AgentWait = "approval" | "input";

export function agentWaiting(
  state: { approvals: readonly Pick<Approval, "agent_id">[]; inputs: readonly Pick<InputRequest, "agent_id">[] },
  agentId: string,
): AgentWait | null {
  if (state.approvals.some((a) => a.agent_id === agentId)) return "approval";
  if (state.inputs.some((i) => i.agent_id === agentId)) return "input";
  return null;
}

/** The row's words for it (the same as the project's "Needs you" line). */
export const WAIT_TEXT: Record<AgentWait, string> = { approval: "Waiting for your approval", input: "Waiting for your answer" };
