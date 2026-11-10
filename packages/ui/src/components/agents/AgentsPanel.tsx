import { childrenOf, descendantCount, type Agent, type ProjectState } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useProject } from "../../state/project";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { StatusIcon } from "../primitives/Status";

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

/** The Agents tab: the whole agent tree; selecting a row opens that agent's tab (Alt: on the other side). */
export function AgentsPanel() {
  const { state, project } = useProject();
  const ws = useWorkspace();
  const currentAgentId = ws.currentAgentId;
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
  const activeId = rows.some((r) => r.agent.id === focusId) ? focusId : currentAgentId;

  const focus = (id: string) => {
    setFocusId(id);
    refs.current.get(id)?.focus();
  };
  const setExpanded = (id: string, value: boolean) => setOverrides((o) => ({ ...o, [id]: value }));
  const open = (a: Agent, otherSide = false) => (a.parent_id === null ? ws.focusChat() : ws.openAgent(a.id, { otherSide }));

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
      Enter: () => open(row.agent, e.altKey),
      " ": () => open(row.agent),
    };
    const fn = moves[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div role="tree" aria-label="Agent tree" className="h-full min-h-0 overflow-y-auto overscroll-contain px-2 pt-1 pb-4">
      {rows.map((row, i) => {
        const a = row.agent;
        const current = a.id === currentAgentId;
        const duration = agentDuration(a, now);
        const isRoot = a.parent_id === null;
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
            title={isRoot ? undefined : a.status === "failed" && a.error ? `${a.title} — failed: ${a.error}` : a.title}
            onFocus={() => setFocusId(a.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={(e) => open(a, e.altKey)}
            className={cn(
              "press-row flex h-7 items-center gap-1 rounded-sm pr-2 text-sm focus-inset",
              current ? "bg-active" : "hover:bg-hover",
            )}
            style={{ paddingLeft: (row.level - 1) * 14 }}
          >
            {/* A 24px target that only toggles: it never opens the agent (keyboard: ←/→ on the row). */}
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(a.id, !row.expanded);
              }}
              className={cn("grid size-6 shrink-0 place-items-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg", !row.hasChildren && "invisible")}
            >
              <ChevronRight size={12} strokeWidth={1.5} absoluteStrokeWidth className={cn("transition-[rotate] duration-150", row.expanded && "rotate-90")} />
            </button>
            {!(isRoot && a.status === "idle") && <StatusIcon status={a.status} />}
            <span className="min-w-0 truncate text-fg">{isRoot ? "Orchestrator" : a.role}</span>
            {row.hidden > 0 && (
              <span className={cn("shrink-0 text-xs tabular-nums", current ? "text-fg-2" : "text-fg-3")} title={`${row.hidden} nested agents hidden`}>
                +{row.hidden}
              </span>
            )}
            {!isRoot && duration !== null && (
              <span className={cn("ml-auto shrink-0 pl-2 text-xs tabular-nums", current ? "text-fg-2" : "text-fg-3")}>{formatDuration(duration)}</span>
            )}
          </div>
        );
      })}
      {rows.length === 1 && <p className="px-2 pt-1 text-xs text-fg-3">No sub-agents yet. They appear here when the orchestrator delegates.</p>}
    </div>
  );
}
