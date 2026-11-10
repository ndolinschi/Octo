import { ancestorsOf, descendantCount, type Agent } from "@octo/agent-client";
import { ChevronDown, ChevronRight, Eye } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration, formatTokens } from "../../lib/format";
import { hrefFor } from "../../lib/route";
import { useProject } from "../../state/project";
import { Markdown } from "./Markdown";
import { StatusIcon, statusLabel, TierBadge } from "../primitives/Status";

export function roleName(agent: Agent): string {
  return agent.parent_id === null ? "Orchestrator" : agent.role;
}

export function Breadcrumb({ agent }: { agent: Agent }) {
  const { projectId, project, state } = useProject();
  const chain = ancestorsOf(state, agent.id);
  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-fg-3">
        <li className="max-w-[180px] truncate">{project?.name}</li>
        {chain.map((a) => (
          <li key={a.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight size={12} aria-hidden className="shrink-0 opacity-60" />
            <a
              href={hrefFor(projectId, a.parent_id === null ? null : a.id)}
              className="max-w-[200px] truncate rounded-xs hover:text-fg"
            >
              {roleName(a)}
            </a>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-1">
          <ChevronRight size={12} aria-hidden className="shrink-0 opacity-60" />
          <span aria-current="page" className="truncate font-medium text-fg-2">
            {roleName(agent)}
          </span>
        </li>
      </ol>
    </nav>
  );
}

export function AgentHeader({ agent, now }: { agent: Agent; now: number }) {
  const { state } = useProject();
  const [briefOpen, setBriefOpen] = useState(false);
  const briefId = useId();
  const duration = agentDuration(agent, now);
  const nested = descendantCount(state, agent.id);

  return (
    <header className="mb-8 border-b border-line pb-5">
      <Breadcrumb agent={agent} />
      <div className="flex items-center gap-2 text-xs text-fg-3">
        <Eye size={13} strokeWidth={1.75} aria-hidden />
        <span>Sub-agent · depth {agent.depth}</span>
      </div>
      <h1 className="mt-1.5 text-xl font-semibold tracking-[-0.015em] text-fg">{agent.role}</h1>
      <p className="mt-0.5 text-[14px] leading-6 text-fg-2">{agent.title}</p>
      <dl className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-3">
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Status</dt>
          <StatusIcon status={agent.status} size={12} />
          <dd className={cn(agent.status === "running" ? "shimmer-text font-medium" : agent.status === "failed" ? "text-err" : "text-fg-2")}>
            {statusLabel(agent.status)}
          </dd>
        </div>
        {agent.tier && (
          <div>
            <dt className="sr-only">Tier and model</dt>
            <dd>
              <TierBadge tier={agent.tier} model={agent.model} />
            </dd>
          </div>
        )}
        {duration !== null && (
          <Meta label="Duration" value={formatDuration(duration)} />
        )}
        <Meta
          label="Tokens"
          value={`${formatTokens(agent.input_tokens)} in · ${formatTokens(agent.output_tokens)} out`}
        />
        {nested > 0 && <Meta label="Nested agents" value={`${nested} nested`} />}
      </dl>
      {agent.task && (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={briefOpen}
            aria-controls={briefId}
            onClick={() => setBriefOpen((o) => !o)}
            className="-ml-1.5 inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-fg-2 hover:bg-hover hover:text-fg"
          >
            <ChevronDown size={13} aria-hidden className={cn("transition-transform", !briefOpen && "-rotate-90")} />
            Task brief
          </button>
          {briefOpen ? (
            <div id={briefId} className="mt-2 rounded-md border border-line bg-inset px-3.5 py-3">
              <Markdown text={agent.task} className="octo-prose text-[13px]! leading-[1.6]!" />
            </div>
          ) : (
            <p id={briefId} className="mt-1 line-clamp-2 text-sm leading-[1.55] text-fg-3">
              {agent.task}
            </p>
          )}
        </div>
      )}
    </header>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="tabular-nums">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
