import type { Agent, ProjectSummary } from "@octo/agent-client";
import { useMemo, useRef } from "react";
import { formatDuration } from "../../lib/format";
import { agentDuration } from "../../lib/duration";
import { useNow } from "../../lib/hooks";
import { useRowKeys } from "../../lib/hooksMore";
import { useRovingRows } from "../../lib/rovingRows";
import { roleText, runningAgents } from "../../lib/orchestrator";
import { navigate } from "../../lib/route";
import { Card } from "../primitives/Card";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";
import { SkeletonList } from "../primitives/Skeleton";
import { RunningDot } from "../primitives/statusMore";
import { StateGlyph } from "../primitives/StateGlyph";
import { WAIT_TEXT, type AgentWait } from "../../lib/agentWaiting";
import { useAgentWaits } from "./useAgentWaits";
import type { ProjectAgents } from "./useOverview";

const TEAM_ROWS = 5;

/**
 * Running sub-agents across projects (decision 23): role, what it is on, the project, how long; a click opens its tab.
 * Decision 75: the card exists only while something runs, so it is absent from Home when nothing does.
 */
export function TeamCard({ projects, agents }: { projects: ProjectSummary[] | null; agents: ProjectAgents[] | null }) {
  const running = useMemo(() => (agents ?? []).flatMap(({ project, agents: list }) => runningAgents(list).map((a) => ({ project, agent: a }))), [agents]);
  const now = useNow(running.length > 0);
  // NEW-3: an agent that waits for an approval or an answer says so instead of looking busy.
  const waits = useAgentWaits(projects);
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  useRovingRows(list);
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
            <TeamRow key={agent.id} project={project} agent={agent} now={now} wait={waits.get(agent.id) ?? null} />
          ))}
          {running.length > TEAM_ROWS && <p className="flex h-ctl-sm items-center px-2 text-xs text-fg-3">+{running.length - TEAM_ROWS} more running</p>}
        </div>
      )}
    </Card>
  );
}

function TeamRow({ project, agent, now, wait }: { project: ProjectSummary; agent: Agent; now: number; wait: AgentWait | null }) {
  const ms = agentDuration(agent, now);
  // 11f: the list item wraps the row's button (a button may not be a listitem).
  return (
    <div role="listitem">
      <ListRow
        size="md"
        leading={wait ? <StateGlyph state="needs" box={16} /> : <RunningDot box={16} />}
        title={`${roleText(agent.role)}${agent.title ? ` · ${agent.title}` : ""}`}
        meta={wait ? `${project.name} · ${WAIT_TEXT[wait]}` : `${project.name}${ms !== null ? ` · ${formatDuration(ms)}` : ""}`}
        tip={`${agent.role}${agent.title ? `: ${agent.title}` : ""} — ${project.name}`}
        onClick={() => navigate(project.id, agent.id)}
      />
    </div>
  );
}
