import type { Agent, ProjectSummary } from "@octo/agent-client";
import { useMemo, useRef, type ReactNode } from "react";
import { agentDuration, formatDuration } from "../../lib/format";
import { useNow, useRowKeys } from "../../lib/hooks";
import { roleText, runningAgents } from "../../lib/orchestrator";
import { navigate } from "../../lib/route";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { INFO_ROW_BUTTON, SkeletonRows } from "../primitives/InfoList";
import { RunningDot } from "../primitives/Status";
import type { ProjectAgents } from "./useOverview";
import type { LucideIcon } from "lucide-react";

const TEAM_ROWS = 5;

function Card(props: { icon: LucideIcon; title: string; aside?: ReactNode; children: ReactNode; label: string }) {
  return (
    <section aria-label={props.label} className="octo-card flex min-w-0 flex-col rounded-lg p-4">
      <div className="mb-3 flex h-5 items-center gap-2 text-sm text-fg-2">
        <Glyph icon={props.icon} size={14} className="shrink-0 text-fg-3" />
        <h2 className="min-w-0 flex-1 truncate">{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

/**
 * Running sub-agents across projects (decision 23): role, what it is on, the project, how long; a click opens its tab.
 * Decision 75: the card exists only while something runs, so it is absent from Home when nothing does.
 */
export function TeamCard({ projects, agents }: { projects: ProjectSummary[] | null; agents: ProjectAgents[] | null }) {
  const running = useMemo(() => (agents ?? []).flatMap(({ project, agents: list }) => runningAgents(list).map((a) => ({ project, agent: a }))), [agents]);
  const now = useNow(running.length > 0);
  const list = useRef<HTMLUListElement>(null);
  useRowKeys(list);
  const shown = running.slice(0, TEAM_ROWS);
  const busy = (projects ?? []).filter((p) => p.status === "running").length;
  if (agents && running.length === 0) return null;
  return (
    <Card
      icon={GLYPH.agents}
      title="Agents at work"
      label="Agents at work"
      aside={busy > 0 && <span className="shrink-0 text-xs text-fg-3">{busy === 1 ? "1 project" : `${busy} projects`}</span>}
    >
      {!agents ? (
        <SkeletonRows count={3} />
      ) : (
        <ul ref={list} className="-mx-2 flex flex-col">
          {shown.map(({ project, agent }) => (
            <li key={agent.id}>
              <TeamRow project={project} agent={agent} now={now} />
            </li>
          ))}
          {running.length > TEAM_ROWS && <li className="flex h-row items-center px-2 text-xs text-fg-3">+{running.length - TEAM_ROWS} more running</li>}
        </ul>
      )}
    </Card>
  );
}

function TeamRow({ project, agent, now }: { project: ProjectSummary; agent: Agent; now: number }) {
  const ms = agentDuration(agent, now);
  return (
    <button
      type="button"
      data-row
      title={`${agent.role}${agent.title ? `: ${agent.title}` : ""} — ${project.name}`}
      onClick={() => navigate(project.id, agent.id)}
      className={INFO_ROW_BUTTON}
    >
      <RunningDot box={16} />
      <span className="max-w-[35%] shrink-0 truncate text-fg">{roleText(agent.role)}</span>
      <span className="min-w-0 flex-1 truncate text-fg-3">{agent.title}</span>
      <span className="max-w-[30%] shrink-0 truncate text-xs text-fg-3">{project.name}</span>
      {ms !== null && <span className="w-12 shrink-0 text-right text-xs text-fg-2 tabular-nums">{formatDuration(ms)}</span>}
    </button>
  );
}
