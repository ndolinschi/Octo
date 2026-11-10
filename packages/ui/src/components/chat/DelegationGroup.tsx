import { agentBySpawnToolUse, childrenOf, descendantCount, type Agent, type ProjectState } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration } from "../../lib/format";
import { hrefFor } from "../../lib/route";
import { spawnInput } from "../../lib/tools";
import type { ToolUse } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { isTier, modelLabel, RunningDot, statusLabel, StatusIcon, tierLabel } from "../primitives/Status";
import { useTranscript } from "./transcriptContext";

const FINISHED = new Set(["completed", "failed", "cancelled"]);

function progress(agents: (Agent | undefined)[]): string {
  const total = agents.length;
  const done = agents.filter((a) => a && FINISHED.has(a.status)).length;
  if (done < total) return `${done}/${total} done`;
  const failed = agents.filter((a) => a?.status === "failed").length;
  const cancelled = agents.filter((a) => a?.status === "cancelled").length;
  if (failed) return `${failed} failed`;
  if (cancelled) return "Stopped";
  return "Done";
}

/**
 * Hairline card for one round of delegation: caption ("3 agents") and progress on one line, then a
 * row per sub-agent. Rows share one grid (subgrid), so glyph, role, title and the right slot line up
 * across rows whatever their lengths.
 */
export function DelegationGroup({ uses }: { uses: ToolUse[] }) {
  const { state } = useProject();
  const agents = uses.map((u) => agentBySpawnToolUse(state, u.id));
  const caption = uses.length === 1 ? "1\u00a0agent" : `${uses.length}\u00a0agents`;
  const status = progress(agents);
  const failed = agents.some((a) => a?.status === "failed");

  return (
    <section aria-label={uses.length === 1 ? "Delegated task" : `${caption} in parallel`} className="@container rounded-md border border-line">
      <div className="flex h-8 items-center gap-3 px-3 text-sm">
        <span className="text-fg-2">{caption}</span>
        <span className={cn("ml-auto text-xs tabular-nums", failed && status.endsWith("failed") ? "text-err" : "text-fg-3")}>{status}</span>
      </div>
      {/* Zero-width edge tracks + the 8px column gap are the rows' inside padding (a subgrid's own
          padding would eat into its first and last tracks): glyph on the caption's 12px line (4 + 8). */}
      <ul className="grid grid-cols-[0px_16px_fit-content(36%)_minmax(0,1fr)_auto_0px] gap-x-2 px-1 pb-1 @max-[440px]:grid-cols-[0px_16px_fit-content(44%)_minmax(0,1fr)_auto_0px]">
        {uses.map((u, i) => (
          <li key={u.id} className="col-span-full grid grid-cols-subgrid">
            <DelegationRow use={u} agent={agents[i]} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DelegationRow({ use, agent }: { use: ToolUse; agent: Agent | undefined }) {
  const { projectId, state } = useProject();
  const ws = useOptionalWorkspace();
  const { now } = useTranscript();
  const input = spawnInput(use.input);
  const role = agent?.role || input.role || "Agent";
  const title = agent?.title || input.title;
  const tier = agent?.tier ?? (isTier(input.tier) ? input.tier : null);
  const status = agent?.status ?? "pending";
  const nested = agent ? descendantCount(state, agent.id) : 0;
  const duration = agent ? agentDuration(agent, now) : null;
  const running = agent?.status === "running";
  const error = status === "failed" ? agent?.error || "No error details were reported." : null;
  const model = agent?.model ? modelLabel(agent.model) : tier ? tierLabel(tier) : "";

  const right = running ? (
    <>
      <span className="min-w-0 truncate">{activity(state, agent.id)}</span>
      {duration !== null && <span className="shrink-0 text-fg-2 tabular-nums">{formatDuration(duration)}</span>}
    </>
  ) : (
    <>
      {status === "pending" && <span>starting</span>}
      {status === "failed" && <span className="text-err">failed</span>}
      {status === "cancelled" && <span>{statusLabel("cancelled")}</span>}
      {model && <span className="@max-[440px]:hidden">{model}</span>}
      {duration !== null && <span className="min-w-[4ch] text-right text-fg-2 tabular-nums">{formatDuration(duration)}</span>}
    </>
  );

  const body = (
    <>
      <span className="col-start-2 grid h-8 place-items-center">{agent ? <StatusIcon status={agent.status} /> : <RunningDot />}</span>
      <span className="flex h-8 min-w-0 items-center gap-1 text-fg">
        <span className="min-w-0 truncate">{role}</span>
        {nested > 0 && (
          <span className="shrink-0 text-xs text-fg-3" title={`${nested} nested`}>
            +{nested}
          </span>
        )}
      </span>
      <span className="block min-w-0 truncate py-1.5 leading-5 text-fg-2">{title}</span>
      <span className="flex h-8 max-w-[24ch] min-w-0 items-center justify-end gap-2 text-xs text-fg-3 @max-[440px]:max-w-[12ch]">{right}</span>
    </>
  );
  // The error line sits under the row (outside it, so the row keeps its 32px), from the role column on.
  const errorLine = error && <span className="col-span-3 col-start-3 -mt-1 truncate pb-2 text-xs text-err">{error}</span>;

  // Radius 4 = card radius (8) − its inset (4).
  const row = "col-span-full grid grid-cols-subgrid items-center rounded-xs text-sm";
  if (!agent)
    return (
      <>
        <div className={row}>{body}</div>
        {errorLine}
      </>
    );
  return (
    <>
      <a
        href={hrefFor(projectId, agent.id)}
        aria-label={`Open ${role}: ${title} (${status})`}
        aria-description={error ?? undefined}
        title={error ?? (agent.task ? `${agent.task}\n\nAlt-click opens it on the other side.` : undefined)}
        onClick={(e) => {
          if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          ws.openAgent(agent.id, { otherSide: e.altKey });
        }}
        className={cn(row, "press-row focus-inset hover:bg-hover")}
      >
        {body}
      </a>
      {errorLine}
    </>
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
