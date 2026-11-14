/* Only lazily loaded views show how long an agent worked: out of `format.ts`, which the entry chunk carries whole. */

export function agentDuration(agent: { started_at: string | null; finished_at: string | null }, now: number): number | null {
  if (!agent.started_at) return null;
  const start = Date.parse(agent.started_at);
  const end = agent.finished_at ? Date.parse(agent.finished_at) : now;
  return end - start;
}
