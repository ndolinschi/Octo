import { childrenOf, descendantCount, type Agent, type ProjectState } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { navigate } from "../../lib/route";
import { useProject } from "../../state/project";
import { shortModel, StatusIcon, TierBadge } from "../primitives/Status";

type Row = { agent: Agent; level: number; hasChildren: boolean; expanded: boolean; hidden: number };

const AUTO_COLLAPSE_DEPTH = 2;

function flatten(state: ProjectState, root: Agent, overrides: Record<string, boolean>): Row[] {
  const rows: Row[] = [];
  const walk = (agent: Agent, level: number) => {
    const kids = childrenOf(state, agent.id);
    const expanded = overrides[agent.id] ?? agent.depth < AUTO_COLLAPSE_DEPTH;
    rows.push({
      agent,
      level,
      hasChildren: kids.length > 0,
      expanded,
      hidden: expanded ? 0 : descendantCount(state, agent.id),
    });
    if (expanded) for (const k of kids) walk(k, level + 1);
  };
  walk(root, 1);
  return rows;
}

export function AgentsPanel({ currentAgentId }: { currentAgentId: string }) {
  const { state, project } = useProject();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const root = project ? state.agents[project.orchestrator_agent_id] : undefined;
  const rows = useMemo(() => (root ? flatten(state, root, overrides) : []), [state, root, overrides]);
  const running = state.agentOrder.filter((id) => {
    const a = state.agents[id];
    return a?.status === "running" && a.parent_id !== null;
  }).length;
  const now = useNow(running > 0);

  if (!root || !project) return null;
  const subCount = state.agentOrder.length - 1;
  const activeId = rows.some((r) => r.agent.id === focusId) ? focusId : currentAgentId;

  const focus = (id: string) => {
    setFocusId(id);
    refs.current.get(id)?.focus();
  };
  const setExpanded = (id: string, value: boolean) => setOverrides((o) => ({ ...o, [id]: value }));
  const open = (a: Agent) => navigate(project.id, a.parent_id === null ? null : a.id);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const row = rows[i];
    const moves: Record<string, () => void> = {
      ArrowDown: () => rows[i + 1] && focus(rows[i + 1].agent.id),
      ArrowUp: () => rows[i - 1] && focus(rows[i - 1].agent.id),
      Home: () => focus(rows[0].agent.id),
      End: () => focus(rows[rows.length - 1].agent.id),
      ArrowRight: () => {
        if (row.hasChildren && !row.expanded) setExpanded(row.agent.id, true);
        else if (row.hasChildren && rows[i + 1]) focus(rows[i + 1].agent.id);
      },
      ArrowLeft: () => {
        if (row.hasChildren && row.expanded) setExpanded(row.agent.id, false);
        else if (row.agent.parent_id) focus(row.agent.parent_id);
      },
      Enter: () => open(row.agent),
      " ": () => open(row.agent),
    };
    const fn = moves[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-4 text-xs text-fg-3">
        <span className="tabular-nums">
          {subCount === 0 ? "No sub-agents yet" : `${subCount} sub-agent${subCount === 1 ? "" : "s"}`}
        </span>
        {running > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="text-accent tabular-nums">{running} working</span>
          </>
        )}
      </div>
      <div role="tree" aria-label="Agent tree" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {rows.map((row, i) => {
          const a = row.agent;
          const current = a.id === currentAgentId;
          const duration = agentDuration(a, now);
          return (
            <div
              key={a.id}
              ref={(el) => {
                if (el) refs.current.set(a.id, el);
                else refs.current.delete(a.id);
              }}
              role="treeitem"
              aria-level={row.level}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-selected={current}
              tabIndex={a.id === activeId ? 0 : -1}
              onFocus={() => setFocusId(a.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onClick={() => open(a)}
              className={cn(
                "group relative flex min-h-[42px] items-start gap-1.5 rounded-md py-1.5 pr-2 transition-colors focus-visible:-outline-offset-2",
                current ? "bg-active" : "hover:bg-hover",
              )}
              style={{ paddingLeft: 4 + (row.level - 1) * 16 }}
            >
              {current && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-accent" />}
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(a.id, !row.expanded);
                }}
                className={cn(
                  "mt-[3px] grid size-4 shrink-0 place-items-center rounded-xs text-fg-3 hover:text-fg",
                  !row.hasChildren && "invisible",
                )}
              >
                <ChevronRight size={12} className={cn("transition-transform duration-150", row.expanded && "rotate-90")} />
              </button>
              <span className="mt-[5px] grid w-3.5 shrink-0 place-items-center">
                <StatusIcon status={a.status} size={12} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn("truncate text-sm", current ? "font-medium text-fg" : "text-fg")}>
                    {a.parent_id === null ? "Orchestrator" : a.role}
                  </span>
                  {row.hidden > 0 && (
                    <span className="shrink-0 rounded-xs bg-hover px-1 text-2xs text-fg-2 tabular-nums" title={`${row.hidden} nested agents hidden`}>
                      +{row.hidden}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-fg-3">
                  {a.tier && <TierBadge tier={a.tier} compact />}
                  <span className="min-w-0 truncate">{a.parent_id === null ? `Project lead · ${shortModel(a.model)}` : a.title}</span>
                </span>
              </span>
              {duration !== null && a.parent_id !== null && (
                <span className="mt-0.5 shrink-0 text-2xs text-fg-3 tabular-nums">{formatDuration(duration)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
