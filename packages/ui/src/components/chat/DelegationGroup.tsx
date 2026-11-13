import { agentBySpawnToolUse, descendantCount, type Agent } from "@octo/agent-client";
import { roleText } from "../../lib/orchestrator";
import { agentActivity } from "../../lib/orchestrator";
import { agentDuration } from "../../lib/format";
import { hrefFor } from "../../lib/route";
import { spawnInput } from "../../lib/toolsMore";
import type { ToolUse } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { isTier, statusLabel, tierLabel } from "../primitives/Status";
import { plainError } from "../../lib/errors/plain";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { useModelNames } from "../../state/models";
import { useTranscript } from "./transcriptContext";
import { IconButton } from "../primitives/IconButton";
import { GLYPH } from "../primitives/glyphs";
import { requestSession } from "../../state/workspace/sessionsStart";

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
 * One round of delegation, unframed: a meta caption ("3 agents · 1/3 done"), then one `ActivityRow` per
 * sub-agent (decision 91d): state glyph, role, dim title, and on the right what it does or the model, then the time.
 */
export function DelegationGroup({ uses }: { uses: ToolUse[] }) {
  const { state } = useProject();
  const agents = uses.map((u) => agentBySpawnToolUse(state, u.id));
  const caption = uses.length === 1 ? "1\u00a0agent" : `${uses.length}\u00a0agents`;
  const status = progress(agents);

  return (
    // Polish step 3, C3: no frame of its own. A meta caption ("3 agents · 1/3 done") over activity rows on the steps' glyph column.
    <section aria-label={uses.length === 1 ? "Delegated task" : `${caption} in parallel`} className="@container">
      <p className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-fg-3">
        <span className="shrink-0 whitespace-nowrap">{caption}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate tabular-nums">{status}</span>
      </p>
      <ul className="flex flex-col">
        {uses.map((u, i) => (
          <li key={u.id}>
            <DelegationRow use={u} agent={agents[i]} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATE: Record<string, ActivityState> = { running: "running", completed: "done", failed: "failed", cancelled: "stopped", pending: "running" };

function DelegationRow({ use, agent }: { use: ToolUse; agent: Agent | undefined }) {
  const { projectId, state } = useProject();
  const ws = useOptionalWorkspace();
  const { now, onOpenSession } = useTranscript();
  const names = useModelNames();
  // The agent's session (project sessions): "Open session" selects it in the Sessions tab, in place when the transcript is in that tab.
  const session = agent ? state.sessions.list.find((s) => s.agent_id === agent.id) : undefined;
  const openSession = () => {
    if (!agent || !session) return;
    if (onOpenSession) return onOpenSession(agent.id);
    requestSession(projectId, session.id);
    ws?.openTool("sessions");
  };
  const input = spawnInput(use.input);
  const role = roleText(agent?.role || input.role);
  const title = agent?.title || input.title;
  const tier = agent?.tier ?? (isTier(input.tier) ? input.tier : null);
  const status = agent?.status ?? "pending";
  const nested = agent ? descendantCount(state, agent.id) : 0;
  const duration = agent ? agentDuration(agent, now) : null;
  const running = agent?.status === "running";
  // Through the failed-turn mapping (a raw "overloaded (529) after 3 retries" never shows); the raw text stays in the tooltip.
  const note = status === "failed" ? (agent?.error ? plainError(agent.error).sentence : "No error details were reported.") : null;
  // A compact place: the served model's name alone (decision 37), the requested one in the row's tooltip.
  const served = agent ? names.served(agent) : null;
  const model = served ? served.name : tier ? tierLabel(tier) : "";
  const aside =
    running && agent
      ? agentActivity(state, agent.id)
      : status === "pending"
        ? "starting"
        : status === "failed"
          ? "failed"
          : status === "cancelled"
            ? statusLabel("cancelled")
            : model;
  const tip =
    (note && agent?.error ? `${note}\n\n${agent.error}` : null) ??
    (agent?.task ? `${agent.task}\n\nAlt-click opens it on the other side.` : served?.asked ? `${served.asked} → ${served.name} (chosen → served)` : undefined);
  return (
    <ActivityRow
      state={STATE[status] ?? "running"}
      verb={
        <>
          {role}
          {nested > 0 && <span className="ml-1 text-xs text-fg-3">+{nested}</span>}
        </>
      }
      detail={title}
      aside={aside}
      duration={duration}
      note={note}
      {...(tip ? { tip } : {})}
      {...(session
        ? {
            trailing: <IconButton icon={GLYPH.sessions} label="Open session" size="xs" onClick={openSession} />,
          }
        : {})}
      {...(agent
        ? {
            href: hrefFor(projectId, agent.id),
            onClick: (e: React.MouseEvent) => {
              if (!ws || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              ws.openAgent(agent.id, { otherSide: e.altKey });
            },
          }
        : {})}
    />
  );
}
