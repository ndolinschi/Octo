import { agentBySpawnToolUse, descendantCount, type Agent } from "@octo/agent-client";
import { Suspense, useCallback, useRef, type MouseEvent } from "react";
import { usePhone } from "../../lib/phone";
import { roleText } from "../../lib/orchestrator";
import { agentActivity } from "../../lib/orchestratorMore";
import { agentDuration } from "../../lib/duration";
import { cn } from "../../lib/cn";
import { useLatest, useNow } from "../../lib/hooks";
import { spawnInput } from "../../lib/toolsMore";
import { type ToolUse, type TurnEnd } from "../../lib/transcript";
import { spawnStatus, type SpawnStatus } from "../../lib/turnEnding";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import { isTier, tierLabel } from "../primitives/statusMore";
import { plainError } from "../../lib/errors/plain";
import { agentWaiting, WAIT_TEXT } from "../../lib/agentWaiting";
import { ActivityRow, type ActivityState } from "./ActivityRow";
import { useModelNames } from "../../state/modelNames";
import { useTranscript } from "./transcriptContext";
import { IconButton } from "../primitives/IconButton";
import { Button } from "../primitives/Button";
import { CHAT } from "../../state/workspace/layout";
import { prefillComposer } from "./composerDraft";
import { GLYPH } from "../primitives/glyphs";
import { labelParts } from "./activity";
import { waitedCards } from "./runCard";
import { useRunCardOpen, useRunHead } from "./useRunCard";
import { RUN_CARD_FRAME, runCardBody } from "./runCardPart";

// Decision 101: fetched with this chunk, so the first card opens at once.
void runCardBody.fetch().catch(() => undefined);
const RunCardBody = runCardBody.Component;

const FINISHED = new Set<SpawnStatus>(["completed", "failed", "cancelled"]);

function progress(statuses: SpawnStatus[], interrupted = false): string {
  const total = statuses.length;
  const done = statuses.filter((s) => FINISHED.has(s)).length;
  if (done < total) return `${done}/${total} done`;
  const failed = statuses.filter((s) => s === "failed").length;
  const cancelled = statuses.filter((s) => s === "cancelled").length;
  if (failed) return `${failed} failed`;
  if (cancelled) return interrupted ? "Interrupted" : "Stopped";
  return "Done";
}

/**
 * One round of delegation, unframed: a meta caption ("3 agents · 1/3 done"), then one `ActivityRow` per
 * sub-agent (decision 91d): state glyph, role, dim title, and on the right what it does or the model, then the time.
 * Decision 101: a row opens into its run card; while the orchestrator waits on the round, the agents it waits on open by
 * themselves (`waitedCards`: each when at most two, else the first), so the wait shows what it consists of.
 */
export function DelegationGroup({
  uses,
  live = false,
  end = null,
  interrupted = false,
}: {
  uses: ToolUse[];
  live?: boolean;
  end?: TurnEnd;
  /** A restart cut the turn: a delegation its interruption closed reads stopped, not failed. */
  interrupted?: boolean;
}) {
  const { state } = useProject();
  const { results } = useTranscript();
  const agents = uses.map((u) => agentBySpawnToolUse(state, u.id));
  // A call that failed before its agent existed (validation) settles from its result; a finished turn leaves no spinner.
  // 3: in a turn a restart cut, a helper the restart failed ("interrupted") reads stopped, like its call.
  const statuses = uses.map((u, i) => {
    const a = agents[i];
    const cut = interrupted && a?.status === "failed" && /^interrupted\b/i.test((a.error ?? "").trim());
    return spawnStatus(cut ? "cancelled" : a?.status, results.get(u.id), live, end, interrupted);
  });
  const caption = uses.length === 1 ? "1 agent" : `${uses.length} agents`;
  // A stopped turn's head already says "Stopped after 14s": the caption does not say it again (the rows say "stopped").
  const status = end === "cancelled" && progress(statuses) === "Stopped" ? null : progress(statuses, interrupted);
  const waited = waitedCards(
    agents.flatMap((a) => (a ? [{ id: a.id, running: a.status === "running" }] : [])),
    live,
  );

  return (
    // Polish step 3, C3: no frame of its own. A meta caption ("3 agents · 1/3 done") over activity rows on the steps' glyph column.
    <section data-activity="" aria-label={uses.length === 1 ? "Delegated task" : `${caption} in parallel`} className="@container">
      <p className="flex h-6 min-w-0 items-center gap-1.5 pl-6 text-xs text-fg-3">
        <span className="shrink-0 whitespace-nowrap">{caption}</span>
        {status && <span aria-hidden>·</span>}
        {status && <span className="min-w-0 truncate tabular-nums">{status}</span>}
      </p>
      <ul className="flex flex-col">
        {uses.map((u, i) => {
          const a = agents[i];
          return (
            <li key={u.id}>
              <DelegationRow use={u} agent={a} status={statuses[i] ?? "pending"} interrupted={interrupted} waited={a ? waited.has(a.id) : false} />
            </li>
          );
        })}
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

/** A label with `code` parts (a command) in mono, as the activity line shows it. */
function LabelText({ label }: { label: string }) {
  return (
    <>
      {labelParts(label).map((p, i) =>
        p.code ? (
          <code key={i} className="font-mono text-xs">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function DelegationRow({
  use,
  agent,
  status,
  interrupted,
  waited,
}: {
  use: ToolUse;
  agent: Agent | undefined;
  status: SpawnStatus;
  interrupted: boolean;
  /** The orchestrator waits on this agent and the waiting rule opens its card. */
  waited: boolean;
}) {
  const { state } = useProject();
  const ws = useOptionalWorkspace();
  const { now, onOpenSession, results, revealNeeds } = useTranscript();
  const names = useModelNames();
  const phone = usePhone();
  const frame = useRef<HTMLDivElement>(null);
  const card = useRunCardOpen(waited, frame);
  const input = spawnInput(use.input);
  const role = roleText(agent?.role || input.role);
  const head = useRunHead(agent, { name: role, interrupted: interrupted && status === "cancelled" });
  const open = card.open && agent !== undefined;
  // Decision 101: "Open session" opens the agent's own tab (in the Sessions tab: its session, in place); Alt opens it in the other pane.
  const openAgent = agent
    ? (other = false) => {
        if (onOpenSession) return onOpenSession(agent.id);
        ws?.openAgent(agent.id, { otherSide: other });
      }
    : null;
  // Stable, so the memoised card body is not re-rendered by this row's own renders (every project event reaches the row).
  const openLatest = useLatest(openAgent);
  const onOpen = useCallback(() => openLatest.current?.(), [openLatest]);
  const title = agent?.title || input.title;
  const tier = agent?.tier ?? (isTier(input.tier) ? input.tier : null);
  const nested = agent ? descendantCount(state, agent.id) : 0;
  const running = agent?.status === "running";
  const liveNow = useNow(running);
  const duration = agent ? agentDuration(agent, running ? liveNow : now) : null;
  // NEW-3: an approval or a form of this agent waits for the person: the row says so (waiting wins over working).
  const wait = agent?.status === "running" ? agentWaiting(state, agent.id) : null;
  // Through the failed-turn mapping (a raw "overloaded (529) after 3 retries" never shows); the raw text stays in the tooltip.
  // Without an agent the reason is the call's own error result (a spawn refused before the agent was created).
  const result = results.get(use.id);
  const raw = agent ? agent.error : result?.is_error && typeof result.content === "string" ? result.content.trim() : null;
  const note = status === "failed" ? (raw ? plainError(raw).sentence : "This agent failed.") : null;
  // A compact place: the served model's name alone (decision 37), the requested one in the row's tooltip.
  const served = agent ? names.served(agent) : null;
  const model = served ? served.name : tier ? tierLabel(tier) : "";
  const aside = wait
    ? WAIT_TEXT[wait]
    : running && agent
      ? agentActivity(state, agent.id)
      : status === "pending"
        ? "starting"
        : !agent && status !== "completed"
          ? "not started"
          : status === "failed"
            ? "failed"
            : status === "cancelled"
              ? interrupted
                ? "interrupted"
                : "stopped"
              : model;
  const phoneActivity = phone && running && !wait && Boolean(aside);
  const tip =
    (note && raw ? `${note}\n\n${raw}` : null) ??
    (agent?.task
      ? `${agent.task}\n\nAlt-click "Open session" opens it in the other pane.`
      : served?.asked
        ? `${served.name} (asked for ${served.asked})`
        : undefined);
  const retry = status === "failed" && ws && (
    <Button
      variant="quiet"
      size="xs"
      title="Puts this request back in the box. Nothing is sent yet."
      onClick={() => {
        prefillComposer(ws.memory, CHAT, retryText(role, agent?.task ?? input.title));
        ws.focusChat();
      }}
    >
      Retry
    </Button>
  );
  const rowState = wait ? "needs" : (STATE[status] ?? "running");
  return (
    <div
      ref={frame}
      data-run-card={open ? (agent.status === "running" ? (wait ? "needs" : "running") : agent.status) : undefined}
      role={open ? "region" : undefined}
      aria-label={open ? `${role}: run` : undefined}
      className={cn("@container/run min-w-0", open && RUN_CARD_FRAME)}
    >
      {open ? (
        // The head: the same row element, now saying what happens (or how it ended), its glyph and elapsed time unchanged.
        <ActivityRow
          state={head.state}
          data="run-head"
          verb={
            <span className="text-fg">
              <LabelText label={head.title} />
            </span>
          }
          duration={duration}
          tip={`${role}: ${head.title}`}
          expands
          open
          onOpenChange={card.toggle}
        />
      ) : (
        <ActivityRow
          // A waiting agent is not working: no spinner (ActivityRow has no needs-you glyph yet; "pending" is its still circle).
          state={rowState}
          {...(wait ? { className: "octo-fade", data: "waiting" } : {})}
          verb={
            <>
              {role}
              {nested > 0 && <span className="ml-1 text-xs text-fg-3">+{nested}</span>}
            </>
          }
          // 5c: on the phone what a running agent does leads its second line (in the meta column it was cut to "Running a com…").
          detail={phoneActivity ? [aside, title].filter(Boolean).join(" · ") : title}
          stacked={phone}
          aside={phoneActivity ? null : aside}
          duration={duration}
          note={note}
          {...(tip ? { tip } : {})}
          trailingShown={status === "failed"}
          {...(agent ? { expands: true, open: false, onOpenChange: card.toggle } : {})}
          {...(retry || openAgent
            ? {
                trailing: (
                  <>
                    {retry}
                    {openAgent && <IconButton icon={GLYPH.sessions} label="Open session" size="xs" onClick={(e: MouseEvent) => openAgent(e.altKey)} />}
                  </>
                ),
              }
            : {})}
        />
      )}
      {open && (
        <Suspense fallback={null}>
          <RunCardBody agentId={agent.id} title={head.title} onOpen={openAgent ? onOpen : undefined} onNeeds={revealNeeds} />
        </Suspense>
      )}
    </div>
  );
}
