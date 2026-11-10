import { agentDuration, formatDuration } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { agentActivity, runningAgents } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { RunningDot } from "../primitives/Status";

const CHIP = "flex h-chip min-w-0 shrink items-center gap-1.5 rounded-sm border border-line px-2 text-xs press-row focus-inset hover:bg-hover";

/**
 * The live team (decision 23): while the orchestrator's turn runs, one 24px chip per running sub-agent above the
 * composer — role, what it is doing, how long — and a click opens its tab. Under 480px of conversation the chips
 * collapse to one "N agents working" chip that opens the Agents tab. Nothing shows while no sub-agent runs (the
 * transcript's "Working…" line covers the orchestrator's own thinking).
 */
export function TeamStrip() {
  const { state } = useProject();
  const ws = useOptionalWorkspace();
  const agents = runningAgents(state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : [])));
  const now = useNow(agents.length > 0);
  if (agents.length === 0) return null;
  const count = agents.length === 1 ? "1 agent working" : `${agents.length} agents working`;
  return (
    <div data-team-strip role="group" aria-label={count} className="flex min-w-0 items-center gap-2 pb-2">
      <div className="flex min-w-0 items-center gap-2 @max-[480px]/conv:hidden">
        {agents.map((a) => {
          const ms = agentDuration(a, now);
          const doing = agentActivity(state, a.id);
          return (
            <button
              key={a.id}
              type="button"
              data-team-chip
              onClick={(e) => ws?.openAgent(a.id, { otherSide: e.altKey })}
              title={`${a.role}${a.title ? `: ${a.title}` : ""} — ${doing}`}
              className={CHIP}
            >
              <RunningDot />
              <span className="shrink-0 text-fg">{a.role}</span>
              <span className="min-w-0 truncate text-fg-3">{doing}</span>
              {ms !== null && <span className="shrink-0 text-fg-2 tabular-nums">{formatDuration(ms)}</span>}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={() => ws?.openTool("agents")} className={`${CHIP} hidden @max-[480px]/conv:flex`}>
        <RunningDot />
        <span className="text-fg-2">{count}</span>
      </button>
    </div>
  );
}
