import { ancestorsOf, descendantCount, type Agent } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { hrefFor } from "../../lib/route";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Markdown } from "./Markdown";
import { modelLabel, statusLabel, tierLabel } from "../primitives/Status";

export function roleName(agent: Agent): string {
  return agent.parent_id === null ? "Orchestrator" : agent.role;
}

export function Breadcrumb({ agent }: { agent: Agent }) {
  const { projectId, project, state } = useProject();
  const ws = useOptionalWorkspace();
  const chain = ancestorsOf(state, agent.id);
  const sep = (
    <span aria-hidden className="text-fg-3">
      /
    </span>
  );
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-fg-3">
        <li className="max-w-[180px] truncate">{project?.name}</li>
        {chain.map((a) => (
          <li key={a.id} className="flex min-w-0 items-center gap-1.5">
            {sep}
            <a
              href={hrefFor(projectId, a.parent_id === null ? null : a.id)}
              onClick={(e) => {
                if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                if (a.parent_id === null) ws.focusChat();
                else ws.openAgent(a.id, { otherSide: e.altKey });
              }}
              className="inline-block h-6 max-w-[200px] truncate rounded-sm py-0.5 leading-5 hover:text-fg"
            >
              {roleName(a)}
            </a>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-1.5">
          {sep}
          <span aria-current="page" className="truncate text-fg-2">
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
  const meta = [
    modelLabel(agent.model),
    agent.tier ? tierLabel(agent.tier) : "",
    duration !== null ? formatDuration(duration) : "",
    nested > 0 ? `${nested} nested` : "",
  ].filter(Boolean);

  return (
    <header className="mb-5">
      <Breadcrumb agent={agent} />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h1 className="shrink-0 text-heading text-fg">{agent.role}</h1>
        {agent.title && <p className="min-w-0 flex-1 truncate text-base text-fg-2">{agent.title}</p>}
        <p className="ml-auto shrink-0 text-xs text-fg-3 tabular-nums" title={agent.model}>
          {meta.map((m) => (
            <span key={m} className="ml-3 first:ml-0">
              {m}
            </span>
          ))}
          <span className={cn("ml-3", agent.status === "failed" ? "text-err" : "text-fg-2")}>{statusLabel(agent.status)}</span>
        </p>
      </div>
      {agent.status === "failed" && (
        <p role="note" className="mt-1.5 text-sm text-fg-2">
          <span className="text-err">{(agent.error || "No error details were reported").replace(/\.$/, "")}.</span> Ask the orchestrator to retry it.
        </p>
      )}
      {agent.task && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={briefOpen}
            aria-controls={briefId}
            onClick={() => setBriefOpen((o) => !o)}
            className="-ml-1.5 inline-flex h-6 press items-center gap-1 rounded-sm px-1.5 text-sm text-fg-3 hover:bg-hover hover:text-fg-2"
          >
            Task brief
            <Glyph icon={ChevronRight} size={14} className={cn("transition-[rotate] duration-150", briefOpen && "rotate-90")} />
          </button>
          {briefOpen && (
            <div id={briefId} className="mt-1 border-l border-line-strong pl-3">
              <Markdown text={agent.task} className="octo-prose octo-prose-sm" />
            </div>
          )}
        </div>
      )}
    </header>
  );
}
