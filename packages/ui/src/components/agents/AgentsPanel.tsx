import type { Agent } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { agentGroups, foldLine, type AgentNode } from "../../lib/agentGroups";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { useNow, useRowKeys } from "../../lib/hooks";
import { agentActivity } from "../../lib/orchestrator";
import { agentGlyph } from "../../lib/stateGlyph";
import { useProject } from "../../state/project";
import { toolTab } from "../../state/workspace/layout";
import { isBooleanRecord, isNumber, slot } from "../../state/workspace/tabMemory";
import { useTabMemory } from "../../state/workspace/useTabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FloatRoom } from "../primitives/floatRoom";
import { Glyph } from "../primitives/Glyph";
import { InfoSection } from "../primitives/InfoList";
import { StateGlyph } from "../primitives/StateGlyph";

const AGENTS_TAB = toolTab("agents");
const EXPANDED = slot("expanded", isBooleanRecord);
const SCROLL = slot("scroll", isNumber);
const NONE_EXPANDED: Record<string, boolean> = {};

const ROW = "flex h-row-nav w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm press-row focus-inset hover:bg-hover max-md:h-bar";

/**
 * The Agents tab (decision 39): Running and Finished, with counts. A row is 32px — state ring, the role, its activity
 * (running) or task title (finished) in `fg-3`, the duration at the right; finished rows are quiet (`fg-2`), failed ones
 * keep the failed ring. What an agent started folds under it as one line ("5 agents, 1 failed") that expands to them at
 * one indent step, deeper ones flattened with "↳ parent". A click opens the agent beside the orchestrator (decision 34).
 * No stop control per agent: the harness can stop the whole turn (the composer's Stop), not one agent.
 */
export function AgentsPanel() {
  const { state } = useProject();
  const ws = useWorkspace();
  const memory = ws.memory;
  const [expanded, setExpanded] = useTabMemory(AGENTS_TAB, EXPANDED, NONE_EXPANDED);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  useRowKeys(rows);
  useLayoutEffect(() => {
    const el = scroller.current;
    const top = memory.get(AGENTS_TAB, SCROLL);
    if (el && top) el.scrollTop = top;
  }, [memory]);
  const agents = useMemo(() => state.agentOrder.flatMap((id) => (state.agents[id] ? [state.agents[id]] : [])), [state.agentOrder, state.agents]);
  const groups = useMemo(() => agentGroups(agents), [agents]);
  const now = useNow(groups.running.length > 0);
  const toggle = (id: string, open: boolean) => setExpanded({ ...expanded, [id]: !open });

  const node = (n: AgentNode, running: boolean) => {
    const fold = foldLine(n);
    // A running agent's sub-agents are open by default; a finished one's folded.
    const open = expanded[n.agent.id] ?? running;
    return (
      <li key={n.agent.id} className="flex flex-col">
        <AgentRow agent={n.agent} now={now} quiet={!running} onOpen={(alt) => ws.openAgent(n.agent.id, { otherSide: alt })} />
        {fold && (
          <button
            type="button"
            data-row
            aria-expanded={open}
            onClick={() => toggle(n.agent.id, open)}
            className="flex h-row w-full min-w-0 items-center gap-2 rounded-sm pr-2 pl-8 text-left text-xs text-fg-3 press-row focus-inset hover:bg-hover hover:text-fg-2 max-md:h-bar"
          >
            <Glyph icon={ChevronRight} size={14} className={cn("-ml-1 shrink-0 transition-[rotate] duration-150", open && "rotate-90")} />
            <span>
              {fold.text}
              {fold.failed && (
                <>
                  , <span className="text-err">{fold.failed}</span>
                </>
              )}
            </span>
          </button>
        )}
        {fold && open && (
          <ul className="flex flex-col pl-6" aria-label={`Started by ${n.agent.role}`}>
            {n.children.map((c) => (
              <li key={c.agent.id}>
                <AgentRow
                  agent={c.agent}
                  via={c.via}
                  now={now}
                  quiet={c.agent.status !== "running"}
                  onOpen={(alt) => ws.openAgent(c.agent.id, { otherSide: alt })}
                />
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  const empty = groups.running.length + groups.finished.length === 0;
  return (
    <div
      ref={scroller}
      data-agents
      onScroll={(e) => memory.set(AGENTS_TAB, SCROLL, e.currentTarget.scrollTop)}
      className="h-full min-h-0 overflow-y-auto overscroll-contain px-pane pt-pane pb-4"
    >
      <div ref={rows} className="mx-auto flex w-full max-w-details flex-col gap-5">
        {empty && (
          <div className="flex flex-col gap-2 px-2 pt-2">
            <p className="text-sm text-fg-2">No agents yet</p>
            <p className="text-xs text-fg-3">They appear here when the orchestrator delegates a task.</p>
            <button
              type="button"
              data-row
              onClick={ws.focusChat}
              className="-ml-2 h-row w-fit rounded-sm px-2 text-sm text-fg press-row focus-inset hover:bg-hover max-md:h-bar"
            >
              Give the orchestrator a task
            </button>
          </div>
        )}
        {groups.running.length > 0 && (
          <InfoSection title={`Running ${groups.running.length}`} labelId="agents-running">
            <ul className="flex flex-col">{groups.running.map((n) => node(n, true))}</ul>
          </InfoSection>
        )}
        {groups.finished.length > 0 && (
          <InfoSection title={`Finished ${groups.finished.length}`} labelId="agents-finished">
            <ul className="flex flex-col">{groups.finished.map((n) => node(n, false))}</ul>
          </InfoSection>
        )}
      </div>
      <FloatRoom />
    </div>
  );
}

function AgentRow(props: { agent: Agent; now: number; quiet: boolean; via?: string | null; onOpen(alt: boolean): void }) {
  const { state } = useProject();
  const a = props.agent;
  const running = a.status === "running";
  const duration = agentDuration(a, props.now);
  const line = running ? agentActivity(state, a.id) : a.status === "failed" ? (a.error ?? a.title) : a.title;
  return (
    <button
      type="button"
      data-row
      data-agent-row={a.status}
      onClick={(e) => props.onOpen(e.altKey)}
      title={`${a.role}${a.title ? `: ${a.title}` : ""}${a.status === "failed" && a.error ? ` — failed: ${a.error}` : ""}\nOpens beside the orchestrator`}
      className={ROW}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <StateGlyph state={agentGlyph(a.status)} />
      </span>
      <span className={cn("max-w-[45%] shrink-0 truncate", props.quiet ? "text-fg-2" : "text-fg")}>
        {props.via && <span className="mr-1.5 text-fg-3">↳ {props.via}</span>}
        {a.role || "Agent"}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{line}</span>
      {duration !== null && <span className="shrink-0 text-xs text-fg-3 tabular-nums">{formatDuration(duration)}</span>}
    </button>
  );
}
