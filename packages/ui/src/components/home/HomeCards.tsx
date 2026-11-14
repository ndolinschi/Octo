import type { Agent, ProjectSummary } from "@octo/agent-client";
import { useMemo, useRef } from "react";
import { formatDuration } from "../../lib/format";
import { agentDuration } from "../../lib/duration";
import { useNow } from "../../lib/hooks";
import { useRowKeys } from "../../lib/hooksMore";
import { roleText, runningAgents } from "../../lib/orchestrator";
import { navigate } from "../../lib/route";
import { Card } from "../primitives/Card";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";
import { SkeletonList } from "../primitives/Skeleton";
import { RunningDot } from "../primitives/Status";
import type { ProjectAgents } from "./useOverview";

const TEAM_ROWS = 5;

/**
 * Running sub-agents across projects (decision 23): role, what it is on, the project, how long; a click opens its tab.
 * Decision 75: the card exists only while something runs, so it is absent from Home when nothing does.
 */
export function TeamCard({ projects, agents }: { projects: ProjectSummary[] | null; agents: ProjectAgents[] | null }) {
  const running = useMemo(() => (agents ?? []).flatMap(({ project, agents: list }) => runningAgents(list).map((a) => ({ project, agent: a }))), [agents]);
  const now = useNow(running.length > 0);
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  const shown = running.slice(0, TEAM_ROWS);
  const busy = (projects ?? []).filter((p) => p.status === "running").length;
  if (agents && running.length === 0) return null;
  return (
    <Card as="section" padding="sm">
      <SectionHeader inset aside={busy > 0 ? <span className="shrink-0 text-xs text-fg-3">{busy === 1 ? "1 project" : `${busy} projects`}</span> : undefined}>
        Agents at work
      </SectionHeader>
      {!agents ? (
        <SkeletonList count={3} size="md" />
      ) : (
        <div ref={list} role="list" className="flex flex-col">
          {shown.map(({ project, agent }) => (
            <TeamRow key={agent.id} project={project} agent={agent} now={now} />
          ))}
          {running.length > TEAM_ROWS && <p className="flex h-ctl-sm items-center px-2 text-xs text-fg-3">+{running.length - TEAM_ROWS} more running</p>}
        </div>
      )}
    </Card>
  );
}

function TeamRow({ project, agent, now }: { project: ProjectSummary; agent: Agent; now: number }) {
  const ms = agentDuration(agent, now);
  return (
    <ListRow
      size="md"
      role="listitem"
      leading={<RunningDot box={16} />}
      title={`${roleText(agent.role)}${agent.title ? ` · ${agent.title}` : ""}`}
      meta={`${project.name}${ms !== null ? ` · ${formatDuration(ms)}` : ""}`}
      tip={`${agent.role}${agent.title ? `: ${agent.title}` : ""} — ${project.name}`}
      onClick={() => navigate(project.id, agent.id)}
    />
  );
}
