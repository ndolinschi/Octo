import { agentBySpawnToolUse, descendantCount, type Agent } from "@octo/agent-client";
import { roleText } from "../../lib/orchestrator";
import { agentActivity } from "../../lib/orchestrator";
import { agentDuration } from "../../lib/duration";
import { hrefFor } from "../../lib/route";
import { spawnInput } from "../../lib/toolsMore";
import { spawnStatus, type SpawnStatus, type ToolUse, type TurnEnd } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { isTier, tierLabel } from "../primitives/statusMore";
import { plainError } from "../../lib/errors/plain";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { useModelNames } from "../../state/modelNames";
import { useTranscript } from "./transcriptContext";
import { IconButton } from "../primitives/IconButton";
import { Button } from "../primitives/Button";
import { CHAT } from "../../state/workspace/layout";
import { prefillComposer } from "./composerDraft";
import { GLYPH } from "../primitives/glyphs";
import { requestSession } from "../../state/workspace/sessionsStart";

const FINISHED = new Set<SpawnStatus>(["completed", "failed", "cancelled"]);

function progress(statuses: SpawnStatus[]): string {
  const total = statuses.length;
  const done = statuses.filter((s) => FINISHED.has(s)).length;
  if (done < total) return `${done}/${total} done`;
  const failed = statuses.filter((s) => s === "failed").length;
  const cancelled = statuses.filter((s) => s === "cancelled").length;
  if (failed) return `${failed} failed`;
  if (cancelled) return "Stopped";
  return "Done";
}

/**
 * One round of delegation, unframed: a meta caption ("3 agents · 1/3 done"), then one `ActivityRow` per
 * sub-agent (decision 91d): state glyph, role, dim title, and on the right what it does or the model, then the time.
 */
export function DelegationGroup({ uses, live = false, end = null }: { uses: ToolUse[]; live?: boolean; end?: TurnEnd }) {
  const { state } = useProject();
  const { results } = useTranscript();
  const agents = uses.map((u) => agentBySpawnToolUse(state, u.id));
  // A call that failed before its agent existed (validation) settles from its result; a finished turn leaves no spinner.
  const statuses = uses.map((u, i) => spawnStatus(agents[i]?.status, results.get(u.id), live, end));
  const caption = uses.length === 1 ? "1\u00a0agent" : `${uses.length}\u00a0agents`;
  // A stopped turn's head already says "Stopped after 14s": the caption does not say it again (the rows say "stopped").
  const status = end === "cancelled" && progress(statuses) === "Stopped" ? null : progress(statuses);

  return (
    // Polish step 3, C3: no frame of its own. A meta caption ("3 agents · 1/3 done") over activity rows on the steps' glyph column.
    <section aria-label={uses.length === 1 ? "Delegated task" : `${caption} in parallel`} className="@container">
      <p className="flex h-6 min-w-0 items-center gap-1.5 text-xs text-fg-3">
        <span className="shrink-0 whitespace-nowrap">{caption}</span>
        {status && <span aria-hidden>·</span>}
        {status && <span className="min-w-0 truncate tabular-nums">{status}</span>}
      </p>
      <ul className="flex flex-col">
        {uses.map((u, i) => (
          <li key={u.id}>
            <DelegationRow use={u} agent={agents[i]} status={statuses[i] ?? "pending"} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The message "Retry" puts in the composer: the helper's name and its task, trimmed to one line. */
export function retryText(role: string, task: string | undefined): string {
  const line = (task ?? "").replace(/\s+/g, " ").trim();
  return `Retry ${role}: ${line.length > 240 ? `${line.slice(0, 237)}…` : line}`.replace(/:\s*$/, "");
}

const STATE: Record<string, ActivityState> = { running: "running", completed: "done", failed: "failed", cancelled: "stopped", pending: "running" };

function DelegationRow({ use, agent, status }: { use: ToolUse; agent: Agent | undefined; status: SpawnStatus }) {
  const { projectId, state } = useProject();
  const ws = useOptionalWorkspace();
  const { now, onOpenSession, results } = useTranscript();
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
  const nested = agent ? descendantCount(state, agent.id) : 0;
  const duration = agent ? agentDuration(agent, now) : null;
  const running = agent?.status === "running";
  // Through the failed-turn mapping (a raw "overloaded (529) after 3 retries" never shows); the raw text stays in the tooltip.
  // Without an agent the reason is the call's own error result (a spawn refused before the agent was created).
  const result = results.get(use.id);
  const raw = agent ? agent.error : result?.is_error && typeof result.content === "string" ? result.content.trim() : null;
  const note = status === "failed" ? (raw ? plainError(raw).sentence : "No error details were reported.") : null;
  // A compact place: the served model's name alone (decision 37), the requested one in the row's tooltip.
  const served = agent ? names.served(agent) : null;
  const model = served ? served.name : tier ? tierLabel(tier) : "";
  const aside =
    running && agent
      ? agentActivity(state, agent.id)
      : status === "pending"
        ? "starting"
        : !agent && status !== "completed"
          ? "not started"
          : status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "stopped"
              : model;
  const tip =
    (note && raw ? `${note}\n\n${raw}` : null) ??
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
      trailingShown={status === "failed"}
      {...(session || (status === "failed" && ws)
        ? {
            trailing: (
              <>
                {status === "failed" && ws && (
                  <Button
                    variant="quiet"
                    size="xs"
                    title="Put a message that asks for this again into the box; nothing is sent until you send it"
                    onClick={() => {
                      prefillComposer(ws.memory, CHAT, retryText(role, agent?.task ?? input.title));
                      ws.focusChat();
                    }}
                  >
                    Retry
                  </Button>
                )}
                {session && <IconButton icon={GLYPH.sessions} label="Open session" size="xs" onClick={openSession} />}
              </>
            ),
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
