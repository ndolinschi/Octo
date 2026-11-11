import type { PluginAgent } from "@octo/agent-client";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { lastTeam, teamLine, teamRoles, type OrchestratorState } from "../../lib/orchestrator";
import { agentGlyph } from "../../lib/stateGlyph";
import { useActivity } from "../../state/activity";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { StateGlyph } from "../primitives/StateGlyph";

const CHIP = "flex h-chip shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-xs whitespace-nowrap press-row focus-inset hover:bg-hover";
/** Room kept for the "+N" button when chips are left out. */
const MORE_WIDTH = 40;

/**
 * Decision 34 — the team is always visible, in the orchestrator's header: working — the running agents as live chips;
 * idle / needs you — "Last ran 6 agents" and the last turn's agents grouped by role ("Code explorer ×4") as quiet chips;
 * no request yet — the agents the orchestrator can call on. A chip opens the agent in a split to the right of the
 * orchestrator. Chips never truncate: as many as fit (measured) show, the rest fold into "+N" (opens Agents).
 */
export function TeamLine({ orchestrator }: { orchestrator: OrchestratorState }) {
  const { state } = useProject();
  const ws = useOptionalWorkspace();
  const agents = state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : []));
  const team = orchestrator.kind === "working" ? orchestrator.agents : orchestrator.kind === "new" ? [] : lastTeam(agents);
  const roles = teamRoles(team);
  const box = useRef<HTMLDivElement>(null);
  const fit = useFitCount(box, roles.map((r) => `${r.role}${r.count}${r.status}`).join("|"));
  if (orchestrator.kind === "new") return <CanCallOn />;
  const shown = roles.slice(0, fit ?? roles.length);
  const rest = roles.slice(shown.length).reduce((n, r) => n + r.count, 0);
  return (
    <div ref={box} data-team-line role="group" aria-label="Team" className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {orchestrator.kind !== "working" && (
        <span data-fit-fixed className="shrink-0 pr-1 text-xs text-fg-3 @max-[520px]/conv:hidden">
          {teamLine(team.length, null, 0)}
        </span>
      )}
      {roles.map((r, i) => (
        <button
          key={r.role}
          type="button"
          data-team-chip
          aria-hidden={i >= shown.length || undefined}
          tabIndex={i >= shown.length ? -1 : undefined}
          onClick={() => ws?.openAgent(r.agent.id)}
          title={`Open ${r.agent.role}${r.agent.title ? `: ${r.agent.title}` : ""} beside the orchestrator`}
          className={cn(CHIP, r.status === "running" ? "text-fg" : "text-fg-2", i >= shown.length && "invisible absolute", "@max-[480px]/conv:hidden")}
        >
          <StateGlyph state={agentGlyph(r.status)} />
          <span>{r.role}</span>
          {r.count > 1 && <span className="text-fg-3 tabular-nums">×{r.count}</span>}
        </button>
      ))}
      {/* With no chip room left, "+N" would repeat the count beside "Last ran N agents": that text is enough. */}
      {rest > 0 && (shown.length > 0 || orchestrator.kind === "working") && (
        <button
          type="button"
          onClick={() => ws?.openTool("agents")}
          title={`Show all ${team.length} agents`}
          className={cn(CHIP, "text-fg-3 tabular-nums @max-[480px]/conv:hidden")}
        >
          +{rest}
        </button>
      )}
      {/* A narrow conversation: one "N agents" chip (bare rings would say nothing). */}
      {team.length > 0 && (
        <button
          type="button"
          onClick={() => ws?.openTool("agents")}
          title={`Show agents: ${roles.map((r) => r.role).join(", ")}`}
          className={cn(CHIP, "hidden text-fg-2 @max-[480px]/conv:flex")}
        >
          <StateGlyph state={orchestrator.kind === "working" ? "working" : "idle"} />
          {team.length} {team.length === 1 ? "agent" : "agents"}
        </button>
      )}
    </div>
  );
}

/** How many chips fit the line beside its fixed text and a "+N" button; null until measured. */
function useFitCount(box: RefObject<HTMLDivElement | null>, key: string): number | null {
  const [count, setCount] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const chips = [...el.querySelectorAll<HTMLElement>("[data-team-chip]")];
      const fixed = [...el.querySelectorAll<HTMLElement>("[data-fit-fixed]")].reduce((n, f) => n + f.offsetWidth + 4, 0);
      const widths = chips.map((c) => c.offsetWidth + 4);
      const total = widths.reduce((n, w) => n + w, 0);
      let room = el.clientWidth - fixed;
      if (total <= room) return setCount(chips.length);
      room -= MORE_WIDTH;
      let n = 0;
      for (const w of widths) {
        if (room < w) break;
        room -= w;
        n += 1;
      }
      setCount(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [box, key]);
  return count;
}

/** Before the first request: the helpers the orchestrator can delegate to (sub-agents, plus available external agents). */
function CanCallOn() {
  const activity = useActivity();
  const [agents, setAgents] = useState<PluginAgent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Without the plugin list the line names sub-agents only; nothing else depends on it.
    activity.plugins().then(
      (plugins) => !cancelled && setAgents(plugins.flatMap((p) => p.agents).filter((a) => a.available)),
      () => !cancelled && setAgents([]),
    );
    return () => {
      cancelled = true;
    };
  }, [activity]);
  const names = ["sub-agents", ...(agents ?? []).map((a) => a.label)];
  return (
    <p data-team-line className="min-w-0 truncate text-xs text-fg-3 @max-[520px]/conv:hidden" title={`Can call on ${names.join(", ")}`}>
      Can call on {names.join(", ")}
    </p>
  );
}
