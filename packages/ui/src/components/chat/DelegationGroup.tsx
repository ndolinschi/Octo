import { agentBySpawnToolUse, childrenOf, descendantCount, type Agent, type ProjectState } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { hrefFor } from "../../lib/route";
import { spawnInput } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { isTier, shortModel, Spinner, StatusIcon, tierLabel } from "../primitives/Status";
import { useTranscript } from "./transcriptContext";

/** Quiet hairline list, one row per sub-agent. */
export function DelegationGroup({ uses }: { uses: ToolUse[] }) {
  const { state } = useProject();
  const parallel = uses.length > 1;
  const caption = parallel ? `${uses.length} agents in parallel` : "Delegated task";

  return (
    <section aria-label={caption} className="my-2">
      {parallel && <p className="mb-1.5 text-sm text-fg-3">{caption}</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
        {uses.map((u) => (
          <li key={u.id}>
            <DelegationRow use={u} agent={agentBySpawnToolUse(state, u.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DelegationRow({ use, agent }: { use: ToolUse; agent: Agent | undefined }) {
  const { projectId, state } = useProject();
  const { now } = useTranscript();
  const input = spawnInput(use.input);
  const role = agent?.role || input.role || "Agent";
  const title = agent?.title || input.title;
  const tier = agent?.tier ?? (isTier(input.tier) ? input.tier : null);
  const status = agent?.status ?? "pending";
  const nested = agent ? descendantCount(state, agent.id) : 0;
  const duration = agent ? agentDuration(agent, now) : null;
  const doing = agent?.status === "running" ? activity(state, agent.id) : "";

  const model = agent?.model ? shortModel(agent.model) : tier ? tierLabel(tier) : "";

  const body = (
    <>
      <span className="grid w-3 shrink-0 place-items-center">{agent ? <StatusIcon status={agent.status} /> : <Spinner />}</span>
      <span className="shrink-0 text-fg">{role}</span>
      {nested > 0 && (
        <span className="-ml-1 shrink-0 text-xs text-fg-3" title={`${nested} nested`}>
          +{nested}
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {title && <span className="min-w-0 truncate text-fg-2">{title}</span>}
        {doing && <span className="max-w-[45%] shrink-0 truncate text-fg-3">{doing}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 pl-2 text-xs text-fg-3">
        {status === "failed" && <span className="text-err">failed</span>}
        {status === "cancelled" && <span>cancelled</span>}
        {status === "pending" && <span>starting</span>}
        {model && <span>{model}</span>}
        {duration !== null && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatDuration(duration)}</span>
          </>
        )}
      </span>
    </>
  );

  const row = "flex h-9 items-center gap-2.5 px-3 text-sm";
  if (!agent) return <div className={row}>{body}</div>;
  return (
    <a
      href={hrefFor(projectId, agent.id)}
      aria-label={`Open ${role}: ${title} (${status})`}
      title={agent.task || undefined}
      className={cn(row, "transition-[background-color] duration-100 hover:bg-hover focus-visible:-outline-offset-2")}
    >
      {body}
    </a>
  );
}

const ACTIVITY: Record<string, string> = {
  bash: "Running a command…",
  read_file: "Reading files…",
  list_dir: "Listing folders…",
  write_file: "Writing files…",
};

function activity(state: ProjectState, agentId: string): string {
  const working = childrenOf(state, agentId).filter((c) => c.status === "running");
  if (working.length) return `Waiting on ${working.map((c) => c.role).join(", ")}…`;
  const tools = Object.values(state.activeTools[agentId] ?? {});
  if (tools.length) return ACTIVITY[tools[0].name] ?? `Using ${tools[0].name}…`;
  return state.streaming[agentId] ? "Writing…" : "Thinking…";
}
