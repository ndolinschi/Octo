import type { ActiveTool, Agent, Message, PlanEntry } from "@octo/agent-client";
import { ArrowUpRight, Square, type LucideIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { WAIT_TEXT, agentWaiting, type AgentWait } from "../../lib/agentWaiting";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/format";
import { routeLine } from "../../lib/modelsMore";
import { locateInProject } from "../../lib/toolsMore";
import { turnLine } from "../../lib/usage/turnLine";
import { useApp } from "../../state/app";
import { useOptionalCode } from "../../state/code";
import { useModelNames } from "../../state/modelNames";
import { useAcpNames } from "../../state/models";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Notice } from "../primitives/Notice";
import { tierLabel } from "../primitives/statusMore";
import { RunSteps } from "./RunCardSteps";
import { routeShort, runActions, runProgress, runSteps, type RunProgress } from "./runCard";
import { useThrottledAnnouncement } from "./useRunCard";

/**
 * Decision 101: the body of a sub-agent's run card, under its head row (the row itself, in `DelegationGroup`, or the agent tab's
 * header): who runs it (label · model · tokens) and why the router chose it, honest progress, the last steps with their times,
 * and what can be done (Stop, Open session; a link to the one "needs you" card, never its buttons). Its own chunk.
 *
 * `RunCardBody` reads the project once per event and hands `RunCardView` only this agent's slices, so another agent's stream
 * does not re-render it (memo), and settled steps do not re-render either (`RunSteps`' rows are memoised).
 */
export function RunCardBody(props: {
  agentId: string;
  /** The head's title (what happens now / the outcome): said in the polite live region while the agent runs. */
  title: string;
  /** `header`: in the agent's own tab (its transcript is right below: no steps, no "Open session"). */
  variant?: "transcript" | "header";
  onOpen?: (() => void) | undefined;
  onNeeds?: (() => void) | undefined;
  /** More of the meta line, already worded (the agent tab: nested agents, context use). */
  extra?: string | undefined;
}) {
  const { state, ensureMessages, projectId } = useProject();
  const { agentId } = props;
  const header = props.variant === "header";
  useEffect(() => {
    if (!header) ensureMessages(agentId);
  }, [agentId, ensureMessages, header]);
  const agent = state.agents[agentId];
  if (!agent) return null;
  const running = agent.status === "running";
  const wait = running ? agentWaiting(state, agentId) : null;
  // What the "needs you" card asks (its title), so the card can say it without its buttons.
  const asks =
    wait === "approval"
      ? state.approvals.find((a) => a.agent_id === agentId)?.title
      : wait === "input"
        ? state.inputs.find((i) => i.agent_id === agentId)?.title
        : undefined;
  return (
    <RunCardView
      asks={asks ?? null}
      agent={agent}
      projectId={projectId}
      messages={header ? undefined : state.messages[agentId]}
      tools={state.activeTools[agentId]}
      plan={state.plan[agentId] ?? agent.plan ?? null}
      wait={wait}
      sessionId={state.sessions.list.find((s) => s.agent_id === agentId)?.id ?? null}
      title={props.title}
      header={header}
      onOpen={props.onOpen}
      onNeeds={props.onNeeds}
      extra={props.extra}
    />
  );
}

export const RunCardView = memo(function RunCardView(p: {
  asks: string | null;
  agent: Agent;
  projectId: string;
  messages: Message[] | undefined;
  tools: Record<string, ActiveTool> | undefined;
  plan: PlanEntry[] | null;
  wait: AgentWait | null;
  sessionId: string | null;
  title: string;
  header: boolean;
  onOpen?: (() => void) | undefined;
  onNeeds?: (() => void) | undefined;
  extra?: string | undefined;
}) {
  const { agent } = p;
  const names = useModelNames();
  const acp = useAcpNames();
  const code = useOptionalCode();
  const folders = code?.folders;
  const locate = useMemo(() => (folders ? (path: string) => locateInProject(folders, path) : () => null), [folders]);
  const running = agent.status === "running";
  const steps = useMemo(() => runSteps(p.messages ?? [], { running, locate, activeTools: p.tools }), [p.messages, running, locate, p.tools]);
  const progress = runProgress(p.plan, steps, agent.status);
  const served = names.served(agent);
  const model = served.name || (agent.tier ? tierLabel(agent.tier) : "");
  const tokens = agent.input_tokens + agent.output_tokens > 0 ? turnLine({ inputTokens: agent.input_tokens, outputTokens: agent.output_tokens }) : null;
  const route = routeShort(agent);
  const actions = runActions({ status: agent.status, waiting: p.wait !== null, canStop: p.sessionId !== null, canOpen: !p.header && p.onOpen !== undefined });
  const live = useThrottledAnnouncement(running ? p.title : null);
  const lastAt = p.messages?.at(-1)?.created_at;
  return (
    <div data-run-body className="flex min-w-0 flex-col gap-2 pb-1 pl-6 text-xs text-fg-3">
      <span ref={live} aria-live="polite" className="sr-only" />
      {/* Who runs it: wraps under the title on a narrow column, never cut mid-name. */}
      <p
        data-run-meta
        className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums"
        title={served.asked ? `${served.name} (asked for ${served.asked})` : undefined}
      >
        <MetaPart first>{agent.role || "Agent"}</MetaPart>
        {model && <MetaPart>{model}</MetaPart>}
        {tokens && <MetaPart>{tokens}</MetaPart>}
        {p.extra && <MetaPart>{p.extra}</MetaPart>}
      </p>
      {route && (
        <p data-run-route className="-mt-1 min-w-0 truncate" title={routeLine(agent, acp) ?? route}>
          {route}
        </p>
      )}
      {/* Waiting for the person is not progress: the mark stands still until they answer. */}
      <Progress progress={progress} still={p.wait !== null} />
      {!p.header && (
        <RunSteps
          steps={steps}
          current={running && !p.wait && !steps.some((s) => s.state === "running") ? { label: p.title, since: lastAt ? Date.parse(lastAt) : null } : null}
        />
      )}
      {actions.length > 0 && <Actions {...p} actions={actions} />}
    </div>
  );
});

function MetaPart({ first = false, children }: { first?: boolean; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
      {!first && <span aria-hidden>·</span>}
      <span className={cn("min-w-0 truncate", first && "text-fg-2")}>{children}</span>
    </span>
  );
}

const SEGMENT: Record<"done" | "current" | "pending", string> = { done: "bg-fg-3", current: "bg-accent", pending: "bg-line-strong" };

/** Decision 101 b: a plan's segments, or a count with an indeterminate mark (never a made-up total). */
function Progress({ progress, still = false }: { progress: RunProgress; still?: boolean }) {
  if (progress.kind === "none") return null;
  return (
    <div data-run-progress={progress.kind} className="flex min-w-0 items-center gap-3">
      <span className="shrink-0 tabular-nums">{progress.label}</span>
      {progress.kind === "plan" ? (
        <span aria-hidden className="flex h-1 min-w-0 flex-1 gap-0.5">
          {progress.segments.map((s, i) => (
            <span key={i} className={cn("h-full min-w-0 flex-1 rounded-full", SEGMENT[s])} />
          ))}
        </span>
      ) : progress.live ? (
        <span aria-hidden className={cn(!still && "octo-run-indeterminate", "relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line-strong")} />
      ) : null}
    </div>
  );
}

/** One action: a labelled button where the card has room, an icon button with the same name (and tooltip) where it has not. */
function Action(props: { icon: LucideIcon; label: string; variant: "quiet" | "danger"; loading?: boolean; onClick(): void }) {
  return (
    // Decision 101 f: the switch is the card's own width (a container query), not the window's: the narrow chat beside an editor
    // and the phone get icons at the same card width.
    <>
      <span className="hidden @min-[20rem]/run:contents">
        <Button variant={props.variant} size="xs" icon={props.icon} loading={props.loading ?? false} onClick={props.onClick}>
          {props.label}
        </Button>
      </span>
      <span className="contents @min-[20rem]/run:hidden">
        <IconButton
          icon={props.icon}
          label={props.label}
          size="xs"
          onClick={props.onClick}
          disabled={props.loading ?? false}
          className={cn(props.variant === "danger" && "text-err")}
        />
      </span>
    </>
  );
}

function Actions(p: {
  agent: Agent;
  projectId: string;
  sessionId: string | null;
  wait: AgentWait | null;
  asks: string | null;
  actions: string[];
  onOpen?: (() => void) | undefined;
  onNeeds?: (() => void) | undefined;
}) {
  const { bridge } = useApp();
  const [stopping, setStopping] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const stop = () => {
    const sid = p.sessionId;
    if (!sid || stopping) return;
    setStopping(true);
    setProblem(null);
    bridge.stopSession(p.projectId, sid).then(
      () => setStopping(false),
      (e: unknown) => {
        setStopping(false);
        setProblem(`Couldn't stop ${p.agent.role || "the agent"}: ${errorMessage(e).replace(/\.$/, "")}. Try again, or stop the whole request.`);
      },
    );
  };
  return (
    <>
      {p.actions.includes("needs") && p.wait && (
        // Decision 91c: the one "needs you" card holds the buttons; this says so and takes the person there.
        <p data-run-needs className="flex min-w-0 items-center gap-1.5 text-fg-2" title={p.asks ?? WAIT_TEXT[p.wait]}>
          <span className="shrink-0">{p.wait === "approval" ? "Approval needed" : "Answer needed"}</span>
          {p.asks && (
            <span className={cn("min-w-0 truncate text-fg-3", p.wait === "approval" && "font-mono")}>
              <span aria-hidden className="font-sans">
                ·{" "}
              </span>
              {p.asks}
            </span>
          )}
          {p.onNeeds && (
            <Button variant="link" size="xs" onClick={p.onNeeds}>
              {p.wait === "approval" ? "Review it" : "Answer it"}
            </Button>
          )}
        </p>
      )}
      <div data-run-actions className="-ml-2 flex items-center gap-1">
        {p.actions.includes("stop") && <Action icon={Square} label="Stop" variant="danger" loading={stopping} onClick={stop} />}
        {p.actions.includes("open") && p.onOpen && (
          <span className="ml-auto">
            <Action icon={ArrowUpRight} label="Open session" variant="quiet" onClick={p.onOpen} />
          </span>
        )}
      </div>
      {problem && <Notice tone="error">{problem}</Notice>}
    </>
  );
}
