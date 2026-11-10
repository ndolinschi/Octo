import { agentBySpawnToolUse, childrenOf, descendantCount, type Agent, type ProjectState } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { hrefFor } from "../../lib/route";
import { spawnInput } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { isTier, shortModel, Spinner, StatusIcon, tierLabel } from "../primitives/Status";
import { useTranscript } from "./transcriptContext";

/** Hairline-bordered card: a caption row, then one row per sub-agent. */
export function DelegationGroup({ uses }: { uses: ToolUse[] }) {
  const { state } = useProject();
  const agents = uses.map((u) => agentBySpawnToolUse(state, u.id));
  const caption = uses.length === 1 ? "1 agent" : `${uses.length} agents`;
  const running = agents.some((a) => !a || a.status === "running");
  const done = agents.filter((a) => a && (a.status === "completed" || a.status === "failed" || a.status === "cancelled")).length;

  return (
    <section aria-label={uses.length === 1 ? "Delegated task" : `${caption} in parallel`} className="@container my-2 rounded-lg border border-line">
      <div className="flex h-8 items-center gap-2 px-3 text-sm text-fg-3">
        <span>{caption}</span>
        {running && (
          <span className="ml-auto tabular-nums">
            {done}/{uses.length} done
          </span>
        )}
      </div>
      <ul className="px-1.5 pb-1.5">
        {uses.map((u, i) => (
          <li key={u.id}>
            <DelegationRow use={u} agent={agents[i]} />
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
  const error = status === "failed" ? agent?.error || "No error details were reported." : null;

  const model = agent?.model ? shortModel(agent.model) : tier ? tierLabel(tier) : "";

  const body = (
    <>
      <span className="flex h-8 min-w-0 items-center gap-2.5">
        <span className="grid w-3 shrink-0 place-items-center">{agent ? <StatusIcon status={agent.status} /> : <Spinner />}</span>
        <span className="max-w-[45%] min-w-0 shrink-0 truncate text-fg">{role}</span>
        {nested > 0 && (
          <span className="-ml-1 shrink-0 text-xs text-fg-3" title={`${nested} nested`}>
            +{nested}
          </span>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {title && <span className="min-w-0 truncate text-fg-2">{title}</span>}
          {doing && <span className="max-w-[45%] shrink-0 truncate text-fg-3 @max-[480px]:hidden">{doing}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pl-1 text-xs text-fg-3">
          {status === "failed" && <span className="text-err">failed</span>}
          {status === "cancelled" && <span>cancelled</span>}
          {status === "pending" && <span>starting</span>}
          {model && <span className="@max-[440px]:hidden">{model}</span>}
          {duration !== null && (
            <>
              <span aria-hidden className="@max-[440px]:hidden">
                ·
              </span>
              <span className="tabular-nums">{formatDuration(duration)}</span>
            </>
          )}
        </span>
      </span>
      {error && <span className="-mt-1 block truncate pb-1.5 pl-[22px] text-xs text-err">{error}</span>}
    </>
  );

  const row = "block rounded-sm px-1.5 text-sm";
  if (!agent) return <div className={row}>{body}</div>;
  return (
    <a
      href={hrefFor(projectId, agent.id)}
      aria-label={`Open ${role}: ${title} (${status})`}
      aria-description={error ?? undefined}
      title={error ?? (agent.task || undefined)}
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
