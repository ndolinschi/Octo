import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { agentActivity, lastTeam, teamRoles, type OrchestratorState } from "../../lib/orchestrator";
import { agentGlyph } from "../../lib/stateGlyph";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { StateGlyph } from "../primitives/StateGlyph";

/** Decision 64 a: the most chips the title bar shows before they fold into one. */
const MAX_CHIPS = 3;

const CHIP = "flex h-chip shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-xs whitespace-nowrap press-row focus-inset hover:bg-hover";

/**
 * Decision 34 in the title bar (the conversation header it lived in is gone, decision 54): the open project's sub-agents as
 * compact chips right of its name — the running ones while it works, the latest turn's team when it is idle or failed
 * (finished ones dimmed). A chip opens that agent's tab. Chips are never cut: when they do not all fit the row (measured)
 * they fold into one "N agents" chip that opens the Agents panel. Nothing shows before the first request.
 */
export function TitleBarTeam({ orchestrator }: { orchestrator: OrchestratorState }) {
  const { state } = useProject();
  const ws = useOptionalWorkspace();
  const agents = state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : []));
  const team = orchestrator.kind === "working" ? orchestrator.agents : orchestrator.kind === "new" ? [] : lastTeam(agents);
  const roles = teamRoles(team);
  const box = useRef<HTMLDivElement>(null);
  // Decision 64 a: at most three chips; more fold into "N agents".
  const fits = useFitsAll(box, roles.map((r) => `${r.role}${r.count}${r.status}`).join("|")) && roles.length <= MAX_CHIPS;
  if (team.length === 0) return null;
  const working = orchestrator.kind === "working";
  const label = `${team.length} ${team.length === 1 ? "agent" : "agents"}`;
  return (
    <div ref={box} data-team-line role="group" aria-label="Agents" className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {roles.map((r) => (
        <button
          key={r.role}
          type="button"
          data-team-chip
          aria-hidden={!fits || undefined}
          tabIndex={fits ? undefined : -1}
          onClick={() => ws?.openAgent(r.agent.id)}
          title={`${r.agent.role}${r.agent.title ? `: ${r.agent.title}` : ""}${r.status === "running" ? ` — ${agentActivity(state, r.agent.id)}` : ""}\nOpens in its own tab`}
          className={cn(CHIP, r.status === "running" ? "text-fg" : "text-fg-3", !fits && "invisible absolute")}
        >
          <StateGlyph state={agentGlyph(r.status)} />
          <span>{r.role}</span>
          {r.count > 1 && <span className="text-fg-3 tabular-nums">×{r.count}</span>}
        </button>
      ))}
      {!fits && (
        <button
          type="button"
          onClick={() => ws?.openTool("agents")}
          title={`Show agents: ${roles.map((r) => r.role).join(", ")}`}
          className={cn(CHIP, working ? "text-fg-2" : "text-fg-3")}
        >
          <StateGlyph state={working ? "working" : "idle"} />
          {label}
        </button>
      )}
    </div>
  );
}

/** Whether every chip fits the row; true until measured (the chips are in the DOM, hidden, while they do not fit). */
function useFitsAll(box: RefObject<HTMLDivElement | null>, key: string): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const widths = [...el.querySelectorAll<HTMLElement>("[data-team-chip]")].map((c) => c.offsetWidth + 4);
      // A collapsed row measures from its hidden chips' natural widths; they keep them (absolute, invisible).
      setFits(widths.reduce((n, w) => n + w, 0) <= el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [box, key]);
  return fits;
}
