import { plainError } from "../../lib/errors/plain";
import { useQuietOpen } from "../../lib/quietFocus";
import { useRovingRows } from "../../lib/rovingRows";
import type { Agent } from "@octo/agent-client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { agentGroups, foldLine, type AgentNode } from "../../lib/agentGroups";
import { cn } from "../../lib/cn";
import { formatDuration } from "../../lib/format";
import { agentDuration } from "../../lib/duration";
import { useNow } from "../../lib/hooks";
import { useRowKeys } from "../../lib/hooksMore";
import { agentActivity } from "../../lib/orchestrator";
import { agentWaiting, WAIT_TEXT } from "../../lib/agentWaiting";
import { agentGlyph } from "../../lib/stateGlyph";
import { useProject } from "../../state/project";
import { toolTab } from "../../state/workspace/layout";
import { isBooleanRecord, isNumber, slot } from "../../state/workspace/tabMemory";
import { useTabMemory } from "../../state/workspace/useTabMemory";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { ProviderMark } from "../primitives/ProviderMark";
import { Panel, PanelBody, PanelEmpty } from "../primitives/Panel";
import { SectionHeader } from "../primitives/SectionHeader";
import { StateGlyph } from "../primitives/StateGlyph";
import { PanelPurpose } from "../shared/PanelPurpose";
import { PANEL_COLUMN } from "../../lib/panelColumn";

const AGENTS_TAB = toolTab("agents");
const EXPANDED = slot("expanded", isBooleanRecord);
const SCROLL = slot("scroll", isNumber);
const NONE_EXPANDED: Record<string, boolean> = {};

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
  // Item 9 (polish pass F3): the list is one Tab stop; ↑/↓/Home/End move between the rows.
  useRovingRows(rows);
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
          <ListRow
            size="md"
            tone="quiet"
            leading={<Glyph icon={open ? ChevronDown : ChevronRight} size={14} />}
            expanded={open}
            className="ml-6"
            title={
              <>
                {fold.text}
                {fold.failed && (
                  <>
                    , <span className="text-err">{fold.failed}</span>
                  </>
                )}
              </>
            }
            onClick={() => toggle(n.agent.id, open)}
          />
        )}
        {fold && open && (
          <ul className="flex flex-col gap-1.5 pt-1 pl-6" aria-label={`Started by ${n.agent.role}`}>
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

  const empty = groups.running.length === 0;
  // B4.3: focus the dock moves here on opening draws no ring until the first key or press.
  const quiet = useRef<HTMLDivElement>(null);
  useQuietOpen(quiet);
  return (
    <div ref={quiet} data-agents className="h-full min-h-0">
      <Panel
        name="agents"
        title="Agents"
        lead={<PanelPurpose tool="agents" />}
        meta={groups.running.length > 0 ? `${groups.running.length} running` : undefined}
        column="measure"
      >
        {empty ? (
          <PanelEmpty
            title="No agents running"
            actions={
              <Button variant="secondary" size="sm" onClick={ws.focusChat}>
                Give the project a task
              </Button>
            }
          >
            They appear here while Octo has sub-agents working.
          </PanelEmpty>
        ) : (
          <PanelBody ref={scroller} onScroll={(e) => memory.set(AGENTS_TAB, SCROLL, e.currentTarget.scrollTop)}>
            <div ref={rows} className={cn("flex flex-col gap-4", PANEL_COLUMN)}>
              <section aria-labelledby="agents-running" className="flex flex-col">
                <SectionHeader inset id="agents-running">{`Running ${groups.running.length}`}</SectionHeader>
                <ul className="flex flex-col gap-1.5">{groups.running.map((n) => node(n, true))}</ul>
              </section>
            </div>
          </PanelBody>
        )}
      </Panel>
    </div>
  );
}

function AgentRow(props: { agent: Agent; now: number; quiet: boolean; via?: string | null; onOpen(alt: boolean): void }) {
  const { state } = useProject();
  const a = props.agent;
  const running = a.status === "running";
  const duration = agentDuration(a, props.now);
  // NEW-3: an approval or a form of this agent waits for the person: that wins over what it was doing.
  const wait = running ? agentWaiting(state, a.id) : null;
  const line = wait
    ? WAIT_TEXT[wait]
    : running
      ? agentActivity(state, a.id)
      : a.status === "failed"
        ? a.error
          ? plainError(a.error).sentence
          : a.title
        : a.title;
  return (
    <ListRow
      size="md"
      tone={props.quiet ? "quiet" : "default"}
      leading={<StateGlyph state={wait ? "needs" : agentGlyph(a.status)} />}
      title={
        <>
          {props.via && <span className="mr-1.5 text-fg-3">↳ {props.via}</span>}
          {a.role || "Agent"}
          <span className="ml-2 text-xs text-fg-3">{line}</span>
        </>
      }
      // N9: the mark of the model's vendor (or the agent CLI it runs through) beside the time, as on the model chips.
      meta={
        <span className="flex items-center gap-1.5 tabular-nums">
          {a.model && <ProviderMark id={a.model} label={a.model} size={14} />}
          {duration !== null && formatDuration(duration)}
        </span>
      }
      tip={`${a.role}${a.title ? `: ${a.title}` : ""}${a.status === "failed" && a.error ? ` — failed: ${a.error}` : ""}\nOpens in its own tab`}
      onClick={(e) => props.onOpen(e.altKey)}
    />
  );
}
