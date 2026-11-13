import { errorFieldsOf, type Agent, type Message, type PlanEntry, type TurnOutcome } from "@octo/agent-client";
import { Check, Copy } from "lucide-react";

import { markSteered } from "../../lib/v7/steer";
import { lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatDuration, formatSeparator, needsSeparator, timeAgo } from "../../lib/format";
import { useCopy } from "../../lib/hooks";
import { splitComments } from "../../lib/comments";
import { buildTurns, compactionSlots, promptText, turnWarning, type Turn } from "../../lib/transcript";
import { agentLabelOf } from "../../lib/errors/words";
import { recheckAgent } from "../../lib/providers/recheck";
import { useApp } from "../../state/app";
import { parseAcp } from "../../lib/models";
import { useAcpNames } from "../../state/models";
import { useProject } from "../../state/project";
import { useActivity } from "../../state/activity";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { useTurnLine } from "./useTurnLine";
import { LazyMarkdown as Markdown } from "./LazyMarkdown";
/** Code comments sent with a prompt render with the first such prompt (their own chunk). */
/** The failed or stopped turn's notice: its own chunk (error mapping, notice, retry), warmed after first paint. */
export const TurnBanner = lazy(() => import("./TurnBanner").then((m) => ({ default: m.TurnBanner })));
const ErrorNotice = lazy(() => import("../shared/ErrorNotice").then((m) => ({ default: m.ErrorNotice })));
const PlanList = lazy(() => import("./LivePanels").then((m) => ({ default: m.PlanList })));
const ThinkingRow = lazy(() => import("./LivePanels").then((m) => ({ default: m.ThinkingRow })));
const PromptImages = lazy(() => import("./PromptImages").then((m) => ({ default: m.PromptImages })));
const SentComments = lazy(() => import("./SentComments").then((m) => ({ default: m.SentComments })));
/** The plan card loads with the first plan (parity B3). */
const CompactedMarker = lazy(() => import("./CompactedMarker").then((m) => ({ default: m.CompactedMarker })));
const PlanForTurn = lazy(() => import("./PlanCard").then((m) => ({ default: m.PlanForTurn })));

/** Plan cards are looked for under this many of the newest requests (a plan belongs to the newest plan turn). */
const PLAN_TURNS = 5;

/** Tool lines and delegation cards: their own chunks, fetched right after the first paint with the Markdown chunk (`AppShell`). */
const ToolGroup = lazy(() => import("./ToolGroup").then((m) => ({ default: m.ToolGroup })));
const DelegationGroup = lazy(() => import("./DelegationGroup").then((m) => ({ default: m.DelegationGroup })));
import { TranscriptContext, useTranscript, type ToolResult, type TranscriptCtx } from "./transcriptContext";
import { proseClass } from "../primitives/Prose";
import { ActivityLine, useBatched } from "./LiveActivity";

/** Memoised: the conversation re-renders on scroll (pinned prompt, jump button); the transcript need not. */
export const Transcript = memo(function Transcript(props: {
  agent: Agent;
  messages: Message[];
  now: number;
  /** This conversation is the one being watched: its live indicator may animate. */
  watched: boolean;
  speaker: string;
  promptAuthor: string;
  hideFirstPrompt?: boolean;
  /** Parity B3: "Keep editing" on a plan card; absent for a sub-agent (plans belong to the orchestrator's requests). */
  onKeepEditing?: (() => void) | undefined;
  /** Parity B5: opens the rewind dialog for a request; absent when the bridge cannot rewind. */
  onRewind?: ((messageId: number) => void) | undefined;
  /** Sessions tab: a pane narrower than the conversation's floor (smaller type, tighter bubbles, time-only reply meta). */
  density?: "compact" | undefined;
  /** Sessions tab: a delegation row's "Open session" selects the agent's session in place (else it opens the Sessions tab). */
  onOpenSession?: ((agentId: string) => void) | undefined;
}) {
  const { agent, messages, now } = props;
  const { state, steered } = useProject();
  // Decision 55 e: streamed text shows at most every 50 ms.
  const streaming = useBatched(state.streaming[agent.id] ?? "");
  const thinking = state.thinking[agent.id] ?? "";
  const plan = state.plan[agent.id] ?? null;
  const stoppedIds = useMemo(() => new Set(messages.filter((m) => m.stopped).map((m) => m.id)), [messages]);
  const running = agent.status === "running";
  const turns = useMemo(() => buildTurns(messages), [messages]);
  // Parity B6: the user messages that landed in a running turn (named by `message.steered`) say so.
  const steeredAt = useMemo(
    () =>
      markSteered(
        steered,
        turns.map((t) => (t.prompt ? promptText(t.prompt) : "")),
      ),
    [steered, turns],
  );

  const ctx = useMemo<TranscriptCtx>(() => {
    const results = new Map<string, ToolResult>();
    for (const m of messages) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
    return { results, agentRunning: running, now, density: props.density === "compact" ? "compact" : "regular", onOpenSession: props.onOpenSession };
  }, [messages, running, now, props.density, props.onOpenSession]);

  const isOrchestrator = agent.parent_id === null;
  const lastTurn = isOrchestrator ? state.lastTurn : null;
  const lastPrompt = turns[turns.length - 1]?.prompt ?? null;
  const markers = state.compactions[agent.id];
  const slots = useMemo(
    () =>
      compactionSlots(
        turns.map((t) => t.prompt?.id ?? null),
        markers ?? [],
      ),
    [turns, markers],
  );
  // A completed turn can carry a `warning:` error (an ACP orchestrator that runs without harness tools): a quiet notice.
  // A failed turn shows from the live event, or after a reload from the orchestrator's own state (failed, or an error
  // that is not a warning: an ACP orchestrator that could not start). Its login hint comes along when the agent has one.
  const failure =
    lastTurn && lastTurn.status !== "completed"
      ? { status: lastTurn.status, error: lastTurn.error, ...errorFieldsOf(lastTurn) }
      : isOrchestrator && (agent.status === "failed" || (agent.error && !turnWarning(agent.error)))
        ? { status: "failed" as const, error: agent.error, ...(agent.error_hint ? { hint: agent.error_hint } : {}) }
        : null;
  const usageLine = useTurnLine(agent, isOrchestrator, running);
  const login = useLoginHint(isOrchestrator && failure ? agent.model : null);
  const { bridge } = useApp();
  const recheck = useCallback(async () => {
    const id = providerIdOf(agent.model);
    const ready = id ? await recheckAgent(bridge, id).catch(() => false) : false;
    login.recheck();
    return ready;
  }, [agent.model, bridge, login]);
  const agentName = useAgentName(agent.model);
  const warning =
    isOrchestrator && !running ? turnWarning(lastTurn?.status === "completed" ? lastTurn.error : agent.status !== "failed" ? agent.error : null) : null;
  // Finished turns only show minutes-old times; a coarse clock lets them skip the per-second tick.
  const minute = Math.floor(now / 60_000) * 60_000;

  return (
    <TranscriptContext.Provider value={ctx}>
      <div className="flex flex-col gap-8">
        {turns.map((turn, i) => {
          const last = i === turns.length - 1;
          const hidePrompt = props.hideFirstPrompt && i === 0;
          const started = turn.prompt?.created_at ?? (i === 0 ? agent.started_at : null);
          const prev = turns[i - 1];
          const separator =
            isOrchestrator && turn.prompt && needsSeparator(prev ? (prev.lastAt ?? prev.prompt?.created_at ?? null) : null, turn.prompt.created_at);
          // An earlier turn keeps its own ending (several can fail in a row); the newest one's is the banner below. A reply
          // cut by a stop is marked even when the ending was not seen live.
          const ended: TurnOutcome | null =
            !isOrchestrator || last
              ? null
              : ((turn.prompt ? state.turnOutcomes[turn.prompt.id] : undefined) ??
                (turn.items.some((it) => stoppedIds.has(Number(it.key.split(".")[0]))) ? { status: "cancelled", error: null } : null));
          return (
            <section key={turn.key} data-turn-id={turn.prompt?.id} className="flex flex-col gap-4">
              {slots.get(i)?.map((m) => (
                <Suspense key={`c${m.upto_message_id}`} fallback={null}>
                  <CompactedMarker marker={m} />
                </Suspense>
              ))}
              {separator && turn.prompt && <TimeSeparator at={turn.prompt.created_at} now={minute} />}
              {turn.prompt && !hidePrompt && (
                <UserPrompt
                  messageId={turn.prompt.id}
                  text={promptText(turn.prompt)}
                  images={turn.prompt.content.filter((b) => b.type === "image")}
                  author={props.promptAuthor}
                  external={!isOrchestrator}
                  steered={steeredAt.has(i)}
                  onRewind={isOrchestrator && !running ? props.onRewind : undefined}
                />
              )}
              <AssistantTurn
                turn={turn}
                speaker={props.speaker}
                live={last && running}
                watched={props.watched}
                agentId={agent.id}
                streaming={last ? streaming : ""}
                thinking={last && running ? thinking : ""}
                plan={last && running ? plan : null}
                startedAt={started}
                now={last ? now : minute}
                footer={isOrchestrator}
                usage={last ? usageLine : null}
              />
              {props.onKeepEditing && turn.prompt && i >= turns.length - PLAN_TURNS && !(last && running) && (
                <Suspense fallback={null}>
                  <PlanForTurn turnId={turn.prompt.id} onKeepEditing={props.onKeepEditing} />
                </Suspense>
              )}
              {ended && ended.status !== "completed" && (
                <Suspense fallback={null}>
                  <TurnBanner status={ended.status} error={ended.error} retryText={null} fields={errorFieldsOf(ended)} agent={agentName} />
                </Suspense>
              )}
            </section>
          );
        })}
        {turns.length === 0 && running && (
          <AssistantTurn
            turn={{ key: "pending", prompt: null, items: [], lastAt: null }}
            speaker={props.speaker}
            live
            watched={props.watched}
            agentId={agent.id}
            streaming={streaming}
            thinking={thinking}
            plan={plan}
            startedAt={agent.started_at}
            now={now}
          />
        )}
        {slots.get(turns.length)?.map((m) => (
          <Suspense key={`c${m.upto_message_id}`} fallback={null}>
            <CompactedMarker marker={m} />
          </Suspense>
        ))}
        {warning && (
          <div data-turn-warning className="-mt-4">
            <Suspense fallback={null}>
              <ErrorNotice tone="info" fields={{ message: warning }} raw={`warning: ${warning}`} agent={agentName} />
            </Suspense>
          </div>
        )}
        {failure && !running && (
          <Suspense fallback={null}>
            <TurnBanner
              status={failure.status}
              error={failure.error}
              retryText={lastPrompt ? promptText(lastPrompt) : null}
              fields={{
                ...failure,
                ...(failure.hint || !login.hint ? {} : { hint: login.hint }),
                ...(failure.action || !login.hint ? {} : { action: "recheck_provider" as const }),
              }}
              agent={agentName}
              providerId={providerIdOf(agent.model)}
              onCheck={recheck}
            />
          </Suspense>
        )}
      </div>
    </TranscriptContext.Provider>
  );
});

/** Orients in a long-lived conversation (decision 18): a centred 12px line before a request after a pause. */
function TimeSeparator({ at, now }: { at: string; now: number }) {
  return (
    <div data-time-sep className="flex h-4 items-center justify-center text-xs text-fg-3 tabular-nums">
      <time dateTime={at} title={new Date(at).toLocaleString()}>
        {formatSeparator(at, now)}
      </time>
    </div>
  );
}

/** Prompts longer than eight lines collapse, with a toggle to read them in full; code comments show as cards. */
const UserPrompt = memo(function UserPrompt({
  messageId,
  text: raw,
  images,
  author,
  external,
  steered,
  onRewind,
}: {
  messageId: number;
  text: string;
  images: Extract<Message["content"][number], { type: "image" }>[];
  author: string;
  external: boolean;
  steered: boolean;
  onRewind: ((messageId: number) => void) | undefined;
}) {
  const { prose: text, comments } = useMemo(() => splitComments(raw), [raw]);
  const compact = useTranscript().density === "compact";
  const box = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const id = useId();

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || expanded) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div data-prompt className="group/prompt relative">
      <div
        data-bubble
        className={cn(
          "rounded-md border border-transparent bg-raised text-fg transition-[box-shadow] duration-300",
          compact ? "p-2 text-sm" : "p-card text-base",
        )}
      >
        {external ? <div className="mb-0.5 text-xs text-fg-3">From {author}</div> : <span className="sr-only">{author}: </span>}
        {steered && (
          <div data-steered className="mb-0.5 text-xs text-fg-3">
            Sent mid-turn
          </div>
        )}
        {text && (
          <div ref={box} id={id} className={cn("wrap-anywhere whitespace-pre-wrap", !expanded && "line-clamp-8")}>
            {text}
          </div>
        )}
        {text && (overflows || expanded) && (
          <Button variant="quiet" size="xs" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((x) => !x)} className="mt-1 -ml-1.5">
            {expanded ? "Show less" : "Show more"}
          </Button>
        )}
        {images.length > 0 && (
          <Suspense fallback={null}>
            <PromptImages blocks={images} />
          </Suspense>
        )}
        {comments.length > 0 && (
          <div className={cn(text && "mt-3")}>
            <Suspense fallback={null}>
              <SentComments comments={comments} />
            </Suspense>
          </div>
        )}
      </div>
      {onRewind && (
        // On the bubble's lower edge, in the gap to the answer: it takes no room and shows on hover or focus (always on touch).
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onRewind(messageId)}
          className="absolute right-3 -bottom-3 z-10 rounded-full bg-overlay opacity-0 shadow-float group-focus-within/prompt:opacity-100 group-hover/prompt:opacity-100 pointer-coarse:opacity-100"
        >
          Rewind to here
        </Button>
      )}
    </div>
  );
});

const AssistantTurn = memo(function AssistantTurn(props: {
  turn: Turn;
  speaker: string;
  live: boolean;
  watched: boolean;
  agentId: string;
  streaming: string;
  thinking: string;
  plan: PlanEntry[] | null;
  startedAt: string | null;
  now: number;
  footer?: boolean;
  /** "model · in / out" of the newest finished turn (decision 86 d). */
  usage?: string | null;
}) {
  const { turn, live, streaming } = props;
  const compact = useTranscript().density === "compact";
  const empty = turn.items.length === 0 && !streaming && !props.thinking;
  if (empty && !live) return null;
  const start = props.startedAt ? Date.parse(props.startedAt) : null;
  const end = turn.lastAt ? Date.parse(turn.lastAt) : null;
  const worked = !live && start !== null && end !== null && end - start >= 1000 ? end - start : null;
  const reply = turn.items.flatMap((item) => (item.kind === "text" ? [item.text] : [])).join("\n\n");
  const prose = proseClass(compact ? "compact" : "reading");
  return (
    // Decision 91j: blocks of a reply (prose, cards) sit 16 apart (12 in the Sessions tab), step rows 8, and the meta line is tight to its reply.
    <article
      aria-label={`${props.speaker} response`}
      className={cn("flex flex-col [&>[data-activity-row]+[data-activity-row]]:-mt-2", compact ? "gap-3" : "gap-4")}
    >
      {worked !== null && <p className={cn("text-fg-3 tabular-nums", compact ? "text-sm" : "text-base")}>Worked for {formatDuration(worked)}</p>}
      <Suspense fallback={null}>
        {live && props.plan && <PlanList entries={props.plan} />}
        {live && <ThinkingRow text={props.thinking} />}
      </Suspense>
      {turn.items.map((item) => {
        if (item.kind === "text") return <Markdown key={item.key} text={item.text} className={prose} fileLinks />;
        return (
          <Suspense key={item.key} fallback={null}>
            {item.kind === "tools" ? <ToolGroup uses={item.uses} /> : <DelegationGroup uses={item.uses} />}
          </Suspense>
        );
      })}
      {streaming && <Markdown text={streaming} className={prose} streaming fileLinks />}
      {live && <ActivityLine agentId={props.agentId} agentName={props.speaker} startedAt={start} now={props.now} watched={props.watched} />}
      {props.footer && !live && reply && turn.lastAt && (
        <TurnFooter reply={reply} at={turn.lastAt} now={props.now} usage={props.usage ?? null} compact={compact} />
      )}
    </article>
  );
});

/**
 * Muted row under a finished orchestrator reply: copy it, when it finished, and the usage. Every segment is `whitespace-nowrap`
 * (the time never breaks as "3d / ago"); the usage gives way first (ellipsis from the right). `compact` (a narrow pane) keeps
 * the time only and puts the usage in its tooltip.
 */
function TurnFooter({ reply, at, now, usage, compact }: { reply: string; at: string; now: number; usage: string | null; compact: boolean }) {
  const [copied, copy] = useCopy();
  const when = new Date(at).toLocaleString();
  return (
    <div
      data-turn-footer
      title={compact && usage ? `${when} · ${usage}` : undefined}
      className="-mt-2 -ml-1 flex h-6 min-w-0 items-center gap-1.5 text-sm text-fg-3"
    >
      <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy reply"} size="xs" className="shrink-0" onClick={() => copy(reply)} />
      <time dateTime={at} title={when} className="shrink-0 whitespace-nowrap tabular-nums">
        {timeAgo(at, now)}
      </time>
      {usage && !compact && <span className="min-w-0 truncate whitespace-nowrap tabular-nums">· {usage}</span>}
    </div>
  );
}

/** The login hint of the ACP agent an `acp:` setting names, when the plugins report it logged out (or give a hint); `recheck` reads it again. */
export function useLoginHint(model: string | null): { hint: string | null; recheck(): void } {
  const activity = useActivity();
  const id = model?.startsWith("acp:") ? model.slice(4).split("/")[0] : undefined;
  const [hint, setHint] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    activity.plugins().then(
      (plugins) => {
        const a = plugins.flatMap((p) => p.agents).find((x) => x.id === id);
        if (alive) setHint(a && a.logged_in !== true && a.hint ? a.hint : null);
      },
      // Unreadable plugin list: the notice keeps its own text and "Check again" asks once more.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [activity, id, round]);
  const recheck = useCallback(() => setRound((n) => n + 1), []);
  return { hint: id ? hint : null, recheck };
}

/** The provider id of an `acp:` model setting, undefined for a plain model. */
export function providerIdOf(model: string | null | undefined): string | undefined {
  return model ? parseAcp(model)?.id : undefined;
}

/** The label of the agent a model setting names (decision 94e): never its id. Null for a plain model. */
export function useAgentName(model: string | null | undefined): string | undefined {
  const acp = useAcpNames();
  const ref = model ? parseAcp(model) : null;
  if (!ref) return undefined;
  return acp.find((a) => a.id === ref.id)?.label ?? agentLabelOf(ref.id);
}
