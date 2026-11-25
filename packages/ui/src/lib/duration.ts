/* Only lazily loaded views show how long an agent worked: out of `format.ts`, which the entry chunk carries whole. */

export function agentDuration(agent: { started_at: string | null; finished_at: string | null }, now: number): number | null {
  if (!agent.started_at) return null;
  const start = Date.parse(agent.started_at);
  const end = agent.finished_at ? Date.parse(agent.finished_at) : now;
  return end - start;
}

/**
 * A step's time on the run card (decision 101 c): tenths under ten seconds ("0.4s", "1.9s"; "<0.1s" for less), whole seconds
 * and minutes above, as `formatDuration` writes them. A live timer keeps whole seconds (it ticks once a second).
 */
export function formatStepDuration(ms: number): string {
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
