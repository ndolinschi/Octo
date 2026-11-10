import { agentBySpawnToolUse, childrenOf, descendantCount, type Agent, type ProjectState } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";
import { agentDuration, excerpt, formatDuration, formatTokens } from "../../lib/format";
import { hrefFor } from "../../lib/route";
import { spawnInput } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { isTier, StatusIcon, StatusLabel, TierBadge } from "../primitives/Status";
import { useTranscript } from "./transcriptContext";

export function DelegationGroup({ uses }: { uses: ToolUse[] }) {
  const { state } = useProject();
  const agents = uses.map((u) => agentBySpawnToolUse(state, u.id));
  const parallel = uses.length > 1;
  const done = agents.filter((a) => a && a.status !== "running").length;

  return (
    <section
      aria-label={parallel ? `${uses.length} agents in parallel` : "Delegated task"}
      className="my-3 overflow-hidden rounded-lg border border-line bg-raised"
    >
      {parallel && (
        <header className="flex h-8 items-center gap-2 border-b border-line px-3.5 text-xs text-fg-3">
          <ParallelGlyph />
          <span className="font-medium text-fg-2">{uses.length} agents in parallel</span>
          <span className="ml-auto tabular-nums">
            {done}/{uses.length} finished
          </span>
        </header>
      )}
      <ul className="divide-y divide-line">
        {uses.map((u, i) => (
          <li key={u.id}>
            <DelegationCard use={u} agent={agents[i]} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DelegationCard({ use, agent }: { use: ToolUse; agent: Agent | undefined }) {
  const { projectId, state } = useProject();
  const { now } = useTranscript();
  const input = spawnInput(use.input);
  const role = agent?.role || input.role || "Agent";
  const title = agent?.title || input.title;
  const tier = agent?.tier ?? (isTier(input.tier) ? input.tier : null);
  const status = agent?.status ?? "pending";
  const nested = agent ? descendantCount(state, agent.id) : 0;
  const duration = agent ? agentDuration(agent, now) : null;
  const tokens = agent ? agent.input_tokens + agent.output_tokens : 0;

  const body = (
    <>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid w-3.5 shrink-0 place-items-center">
          {agent ? <StatusIcon status={agent.status} /> : <StatusLabel status="pending" className="sr-only" />}
        </span>
        <span className="shrink-0 text-sm font-medium text-fg">{role}</span>
        {title && <span className="min-w-0 truncate text-sm text-fg-2">{title}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 text-2xs text-fg-3 tabular-nums">
          {status === "running" ? <StatusLabel status="running" /> : !agent && <StatusLabel status="pending" />}
          {nested > 0 && (
            <span title={`${nested} nested agent${nested === 1 ? "" : "s"}`} className="text-fg-2">
              +{nested}
            </span>
          )}
          {duration !== null && <span>{formatDuration(duration)}</span>}
          {tokens > 0 && <span>{formatTokens(tokens)} tok</span>}
          {tier && <TierBadge tier={tier} model={agent?.model} />}
          {agent && (
            <ChevronRight
              size={14}
              aria-hidden
              className="-mr-1 text-fg-3 transition-transform group-hover:translate-x-0.5 group-hover:text-fg-2"
            />
          )}
        </span>
      </div>
      <Detail agent={agent} />
    </>
  );

  if (!agent) return <div className="px-3.5 py-2.5">{body}</div>;
  return (
    <a
      href={hrefFor(projectId, agent.id)}
      aria-label={`Open ${role}: ${title} (${status})`}
      className="group block px-3.5 py-2.5 transition-colors hover:bg-hover focus-visible:-outline-offset-2"
    >
      {body}
    </a>
  );
}

function Detail({ agent }: { agent: Agent | undefined }) {
  const { state } = useProject();
  if (!agent) return null;
  let text = "";
  let tone = "text-fg-3";
  if (agent.status === "failed" || agent.status === "cancelled") {
    text = agent.error ?? (agent.status === "cancelled" ? "Cancelled before finishing." : "Failed.");
    tone = agent.status === "failed" ? "text-err" : "text-fg-3";
  } else if (agent.result) {
    text = excerpt(agent.result, 240);
  } else if (agent.status === "running") {
    const stream = state.streaming[agent.id];
    text = stream ? `…${excerpt(stream, 400).slice(-160)}` : activity(state, agent.id) || "Thinking…";
  }
  if (!text) return null;
  return <p className={cn("mt-1 line-clamp-2 pl-6 text-xs leading-[18px]", tone)}>{text}</p>;
}

const ACTIVITY: Record<string, string> = {
  bash: "Running a command",
  read_file: "Reading files",
  list_dir: "Listing folders",
  write_file: "Writing files",
};

function activity(state: ProjectState, agentId: string): string {
  const working = childrenOf(state, agentId).filter((c) => c.status === "running");
  if (working.length) return `Waiting on ${working.map((c) => c.role).join(", ")}`;
  const tools = Object.values(state.activeTools[agentId] ?? {});
  if (tools.length) return ACTIVITY[tools[0].name] ?? `Using ${tools[0].name}`;
  return "";
}

function ParallelGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="text-fg-3">
      <path d="M2 2v8M6 2v8M10 2v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
