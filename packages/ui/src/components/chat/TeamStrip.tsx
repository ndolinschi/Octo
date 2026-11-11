import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { agentActivity, runningAgents } from "../../lib/orchestrator";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { RunningDot } from "../primitives/Status";

const CHIP = "flex h-chip shrink-0 items-center gap-1.5 rounded-sm border border-line px-2 text-xs whitespace-nowrap press-row focus-inset hover:bg-hover";

/**
 * The live team (decision 23): while the orchestrator's turn runs, one 24px chip per running sub-agent above the
 * composer — role, what it is doing, how long — and a click opens its tab. Chips are as wide as their text (up to
 * 320px, the activity truncating only past that); when they do not all fit on one line (measured), the strip collapses
 * to one "N agents working" chip that opens the Agents tab — it never wraps. Nothing shows while no sub-agent runs
 * (the transcript's "Working…" line covers the orchestrator's own thinking).
 */
export function TeamStrip() {
  const { state } = useProject();
  const ws = useOptionalWorkspace();
  const agents = runningAgents(state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : [])));
  const now = useNow(agents.length > 0);
  const box = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const ids = agents.map((a) => a.id).join(",");
  useLayoutEffect(() => {
    const outer = box.current;
    const inner = row.current;
    if (!outer || !inner) return;
    const measure = () => setFits(inner.scrollWidth <= outer.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [ids]);
  if (agents.length === 0) return null;
  const count = agents.length === 1 ? "1 agent working" : `${agents.length} agents working`;
  return (
    <div ref={box} data-team-strip role="group" aria-label={count} className="relative flex min-w-0 items-center pb-2">
      {/* Always rendered (for measuring); hidden and inert while it does not fit. */}
      <div ref={row} aria-hidden={!fits} inert={!fits} className={cn("flex w-max items-center gap-2", !fits && "invisible absolute top-0 left-0")}>
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
              className={cn(CHIP, "max-w-80")}
            >
              <RunningDot />
              <span className="shrink-0 text-fg">{a.role}</span>
              <span className="min-w-0 truncate text-fg-3">{doing}</span>
              {ms !== null && <span className="shrink-0 text-fg-2 tabular-nums">{formatDuration(ms)}</span>}
            </button>
          );
        })}
      </div>
      {!fits && (
        <button type="button" onClick={() => ws?.openTool("agents")} className={CHIP}>
          <RunningDot />
          <span className="text-fg-2">{count}</span>
        </button>
      )}
    </div>
  );
}
