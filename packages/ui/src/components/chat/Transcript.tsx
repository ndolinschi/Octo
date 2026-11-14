import { errorFieldsOf, type Agent, type ErrorFields, type Message, type PlanEntry, type TurnOutcome } from "@octo/agent-client";
import { Check, Copy } from "lucide-react";

import { markSteered } from "../../lib/v7/steer";
import { lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { cn } from "../../lib/cn";
import { formatSeparator, needsSeparator, timeAgo } from "../../lib/format";
import { useCopy } from "../../lib/hooks";
import { splitComments } from "../../lib/comments";
import {
  buildTurns,
  compactionSlots,
  promptText,
  stepState,
  turnDurationMs,
  turnFailureText,
  turnHead,
  turnWarning,
  type StoredEnding,
  type Turn,
  type TurnEnd,
} from "../../lib/transcript";
import type { StoredEndingLookup } from "../../lib/storedEndings";
import { useStopping } from "../../lib/stopping";
import { hasLongWord } from "../../lib/composerInput";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { useTurnLine } from "./useTurnLine";
import { providerIdOf, useAgentName, useLoginHint } from "./agentName";
import { LazyMarkdown as Markdown, markdownPart } from "./LazyMarkdown";
import { readyLazy, usePartsReady } from "./readyLazy";
import { turnSig, useTurnWindow } from "./useTurnWindow";
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
const TurnChanges = lazy(() => import("./TurnChanges").then((m) => ({ default: m.TurnChanges })));

/** Plan cards are looked for under this many of the newest requests (a plan belongs to the newest plan turn). */
const PLAN_TURNS = 5;

/** Tool lines and delegation cards: their own chunks, fetched right after the first paint with the Markdown chunk (`AppShell`). */
const toolGroup = readyLazy(() => import("./ToolGroup").then((m) => m.ToolGroup));
const delegationGroup = readyLazy(() => import("./DelegationGroup").then((m) => m.DelegationGroup));
const ToolGroup = toolGroup.Component;
const DelegationGroup = delegationGroup.Component;
/** A long conversation mounts its turns once these are in, so each turn is laid out once, complete (no shift on open). */
const TURN_PARTS = [markdownPart, toolGroup, delegationGroup];
import { TranscriptContext, useTranscript, type ToolResult, type TranscriptCtx } from "./transcriptContext";
import { proseClass } from "../primitives/Prose";
import { ActivityLine, useBatched } from "./LiveActivity";
import { ActivityRow } from "./ActivityRow";

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
  const { state, steered, projectId, running: projectRunning } = useProject();
  // G5: the person pressed Stop and the harness has not ended the turn yet.
  const stopping = useStopping(projectId, projectRunning) !== null;
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
  // B4: how each request ended as the harness stored it, so a stopped turn reads the same after a reload as it did live.
  const { lookup: storedEndingOf, settled: endingsSettled } = useStoredEndings(isOrchestrator && !running, `${turns.length}:${state.lastTurn?.status ?? ""}`);
  const storedLast = isOrchestrator ? storedEndingOf(lastPrompt) : undefined;
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
  // NEW-5: a send that fails clears `lastTurn` before the harness answers; the latest request's own live outcome stays.
  const lastOutcome = lastTurn ?? (isOrchestrator && lastPrompt ? state.turnOutcomes[lastPrompt.id] : undefined) ?? null;
  // NEW-1: without an error of its own (the agent row's is gone after a reload), a failed turn says what it holds itself.
  const lastTurnItems = turns[turns.length - 1];
  type Failure = { status: "failed" | "cancelled"; error: string | null } & ErrorFields;
  const withOwnReason = (f: Failure): Failure & { fromStep: boolean } => {
    const own = f.status === "failed" && !f.error && lastTurnItems ? turnFailureText(lastTurnItems, ctx.results) : null;
    return { ...f, error: f.error ?? own, fromStep: own !== null };
  };
  const failure =
    lastOutcome && lastOutcome.status !== "completed"
      ? withOwnReason({ status: lastOutcome.status, error: lastOutcome.error, ...errorFieldsOf(lastOutcome) })
      : isOrchestrator && (agent.status === "failed" || (agent.error && !turnWarning(agent.error)))
        ? withOwnReason({ status: "failed" as const, error: agent.error, ...(agent.error_hint ? { hint: agent.error_hint } : {}) })
        : !lastTurn && (storedLast?.status === "cancelled" || storedLast?.status === "failed")
          ? withOwnReason({ status: storedLast.status, error: storedLast.error ?? null })
          : null;
  const usageLine = useTurnLine(agent, isOrchestrator, running);
  const login = useLoginHint(isOrchestrator && failure ? agent.model : null);
  const { bridge } = useApp();
  const recheck = useCallback(async () => {
    const id = providerIdOf(agent.model);
    // "Check again" loads its module on the first press.
    const ready = id ? await import("../../lib/providers/recheck").then((m) => m.recheckAgent(bridge, id)).catch(() => false) : false;
    login.recheck();
    return ready;
  }, [agent.model, bridge, login]);
  const agentName = useAgentName(agent.model);
  const warning =
    isOrchestrator && !running ? turnWarning(lastTurn?.status === "completed" ? lastTurn.error : agent.status !== "failed" ? agent.error : null) : null;
  // Finished turns only show minutes-old times; a coarse clock lets them skip the per-second tick.
  const minute = Math.floor(now / 60_000) * 60_000;
  // P1-6: only the turns near the viewport are mounted (and none before the Markdown chunk is in, so each lays out once).
  const { root: turnsRoot, observe, isMounted, heightAt } = useTurnWindow(agent.id, turns, usePartsReady(TURN_PARTS));
  // An unmounted turn's element is reused while its height holds: the transcript re-renders on every streamed delta, and
  // creating hundreds of placeholder elements each time was most of that render.
  const [shellKey] = useState(() => ({}));
  const shell = (turn: Turn, i: number) => {
    const height = heightAt(i);
    const sig = turnSig(turn);
    let mine = shells.get(shellKey);
    if (!mine) shells.set(shellKey, (mine = new Map<string, Shell>()));
    const hit = mine.get(turn.key);
    if (hit?.height === height && hit.sig === sig) return hit.el;
    const el = (
      <section key={turn.key} ref={observe} data-turn-id={turn.prompt?.id} data-turn-key={turn.key} style={{ height }}>
        <FindText turn={turn} />
      </section>
    );
    mine.set(turn.key, { height, sig, el });
    return el;
  };

  return (
    <TranscriptContext.Provider value={ctx}>
      {/* NEW-4: until the stored endings are in (the first read only, at most ENDINGS_WAIT_MS) the turns are laid out but not
          shown, so no row changes under the reader and no placeholder is seen being replaced. */}
      <div ref={turnsRoot} className={cn("flex flex-col gap-8", !endingsSettled && "invisible")}>
        {turns.map((turn, i) => {
          if (!isMounted(i)) return shell(turn, i);
          const last = i === turns.length - 1;
          const hidePrompt = props.hideFirstPrompt && i === 0;
          const started = turn.prompt?.created_at ?? (i === 0 ? agent.started_at : null);
          const prev = turns[i - 1];
          const separator =
            isOrchestrator && turn.prompt && needsSeparator(prev ? (prev.lastAt ?? prev.prompt?.created_at ?? null) : null, turn.prompt.created_at);
          // An earlier turn keeps its own ending (several can fail in a row); the newest one's is the banner below. A reply
          // cut by a stop is marked even when the ending was not seen live.
          const cut = turn.items.some((it) => stoppedIds.has(Number(it.key.split(".")[0])));
          const stored = isOrchestrator ? storedEndingOf(turn.prompt) : undefined;
          const ended: TurnOutcome | null =
            !isOrchestrator || last
              ? null
              : ((turn.prompt ? state.turnOutcomes[turn.prompt.id] : undefined) ??
                (stored ? { status: stored.status, error: stored.error ?? null } : cut ? { status: "cancelled", error: null } : null));
          // How the turn ended, for its head row and its steps (a stopped turn's interrupted call reads "stopped").
          const end: TurnEnd =
            last && running
              ? null
              : !last
                ? (ended?.status ?? (cut ? "cancelled" : null))
                : isOrchestrator
                  ? (lastTurn?.status ?? failure?.status ?? stored?.status ?? (cut ? "cancelled" : null))
                  : agent.status === "failed" || agent.status === "cancelled"
                    ? agent.status
                    : cut
                      ? "cancelled"
                      : null;
          return (
            <section key={turn.key} ref={observe} data-turn-id={turn.prompt?.id} data-turn-key={turn.key} data-turn-mounted className="flex flex-col gap-4">
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
                  content={turn.prompt.content}
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
                stopping={last && running && stopping}
                watched={props.watched}
                agentId={agent.id}
                streaming={last ? streaming : ""}
                thinking={last && running ? thinking : ""}
                plan={last && running ? plan : null}
                startedAt={started}
                finishedAt={last ? agent.finished_at : null}
                stored={stored}
                now={last ? now : minute}
                end={end}
                footer={isOrchestrator}
                usage={last ? usageLine : null}
              />
              {props.onKeepEditing && turn.prompt && i >= turns.length - PLAN_TURNS && !(last && running) && (
                <Suspense fallback={null}>
                  <PlanForTurn turnId={turn.prompt.id} onKeepEditing={props.onKeepEditing} />
                </Suspense>
              )}
              {/* C5: a stopped earlier turn says so once, in its head; only a failure keeps its notice. */}
              {ended?.status === "failed" && (
                <Suspense fallback={null}>
                  {/* NEW-1: no stored error (the harness keeps none with an exchange): the turn's own last error, else "This request failed." */}
                  <TurnBanner
                    status={ended.status}
                    error={ended.error ?? turnFailureText(turn, ctx.results)}
                    fromStep={!ended.error}
                    retryText={turn.prompt ? promptText(turn.prompt) : null}
                    fields={errorFieldsOf(ended)}
                    agent={agentName}
                  />
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
        {failure?.status === "cancelled" && !running && (
          // C5: the head already says "Stopped after 8s"; the notice keeps only what to do next.
          <p data-turn-outcome="cancelled" className="octo-fade text-sm text-fg-3">
            Send a message to continue.
          </p>
        )}
        {failure?.status === "failed" && !running && (
          <Suspense fallback={null}>
            <TurnBanner
              status={failure.status}
              error={failure.error}
              fromStep={failure.fromStep}
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

/**
 * Orients in a long-lived conversation (decision 18): a centred 12px line before a request after a pause. Polish step 3, C7:
 * the one marker style of the transcript (meta text centred on a hairline), shared with the compacted / rewound marker and
 * "New session started"; 32 above (between turns) and 16 below (to the request).
 */
function TimeSeparator({ at, now }: { at: string; now: number }) {
  return (
    <div data-time-sep className="flex h-4 items-center gap-3 text-xs text-fg-3 tabular-nums">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <time dateTime={at} title={new Date(at).toLocaleString()}>
        {formatSeparator(at, now)}
      </time>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * A turn that is not mounted keeps its text for the browser's find, laid out by nothing (`hidden="until-found"`, set through the
 * ref: an engine without it treats the attribute as plain `hidden`). A match mounts the turn (`useTurnWindow`).
 */
const FindText = memo(function FindText({ turn }: { turn: Turn }) {
  const text = useMemo(
    () => [turn.prompt ? promptText(turn.prompt) : "", ...turn.items.flatMap((it) => (it.kind === "text" ? [it.text] : []))].filter(Boolean).join("\n\n"),
    [turn],
  );
  return <div ref={untilFound}>{text}</div>;
});

function untilFound(el: HTMLDivElement | null) {
  el?.setAttribute("hidden", "until-found");
}

/** Prompts longer than eight lines collapse, with a toggle to read them in full; code comments show as cards. */
const UserPrompt = memo(function UserPrompt({
  messageId,
  text: raw,
  content,
  author,
  external,
  steered,
  onRewind,
}: {
  messageId: number;
  text: string;
  /** The prompt message's blocks (a stable array: a filtered copy made each render re-rendered every prompt on every delta). */
  content: Message["content"];
  author: string;
  external: boolean;
  steered: boolean;
  onRewind: ((messageId: number) => void) | undefined;
}) {
  const { prose: text, comments } = useMemo(() => splitComments(raw), [raw]);
  const images = useMemo(() => content.filter((b) => b.type === "image"), [content]);
  // P1-5: a pasted log's long word is set without kerning, or every layout of the transcript re-shapes it for seconds.
  const longWord = useMemo(() => hasLongWord(text), [text]);
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
          <div ref={box} id={id} data-long-word={longWord || undefined} className={cn("wrap-anywhere whitespace-pre-wrap", !expanded && "line-clamp-8")}>
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
  /** G5: Stop was pressed; the live row says "Stopping…" until the turn ends. */
  stopping?: boolean;
  watched: boolean;
  agentId: string;
  streaming: string;
  thinking: string;
  plan: PlanEntry[] | null;
  startedAt: string | null;
  /** The agent's `finished_at`, for its latest turn: where a stopped or failed turn's time ends (B4). */
  finishedAt?: string | null | undefined;
  /** The turn's stored exchange (its duration), when the harness has one. */
  stored?: StoredEnding | undefined;
  now: number;
  /** How the turn ended (null while it runs or when unknown). */
  end?: TurnEnd;
  footer?: boolean;
  /** "model · in / out" of the newest finished turn (decision 86 d). */
  usage?: string | null;
}) {
  const { turn, live, streaming } = props;
  const ctx = useTranscript();
  const compact = ctx.density === "compact";
  // Polish step 3, C1: a finished turn's tool rows fold under its "Worked for…" head; null = the default (open only when a step failed).
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);
  const empty = turn.items.length === 0 && !streaming && !props.thinking;
  const start = props.startedAt ? Date.parse(props.startedAt) : null;
  const ms = turnDurationMs(start, { live, lastAt: turn.lastAt, finishedAt: props.finishedAt, stored: props.stored });
  const worked = ms !== null && ms >= 1000 ? ms : null;
  const ending = props.end ?? null;
  const toolUses = turn.items.flatMap((item) => (item.kind === "tools" ? item.uses : []));
  const steps = toolUses.map((u) => stepState(ctx.results.get(u.id), ctx.agentRunning, ending));
  // Open by default when a step failed or was stopped (the head of a stopped turn shows what the stop cut).
  const showSteps = worked === null || (stepsOpen ?? steps.some((s) => s === "error" || s === "stopped"));
  const head = worked === null ? null : turnHead(ending, worked, steps, props.stored);
  // G13: a head that changes after it was first shown (a live turn ending, a stop confirmed) comes in with the calm fade;
  // one that mounts as it is (a turn scrolled into view) does not.
  const [firstHead] = useState(() => head?.label ?? null);
  const headChanged = head !== null && head.label !== firstHead;
  if (empty && !live) return null;
  const reply = turn.items.flatMap((item) => (item.kind === "text" ? [item.text] : [])).join("\n\n");
  // The newest step row above, when it already says what the activity line would: a streaming thinking row (nothing after it), a running tool group.
  const lastItem = turn.items[turn.items.length - 1];
  const currentStep: "thinking" | "tool" | null = streaming
    ? null
    : lastItem === undefined
      ? props.thinking
        ? "thinking"
        : null
      : lastItem.kind === "tools" && lastItem.uses.some((u) => stepState(ctx.results.get(u.id), ctx.agentRunning, ending) === "running")
        ? "tool"
        : null;
  const prose = proseClass(compact ? "compact" : "reading");
  return (
    // Decision 91j: blocks of a reply (prose, cards) sit 16 apart (12 in the Sessions tab), step rows 8, and the meta line is tight to its reply.
    <article
      aria-label={`${props.speaker} response`}
      className={cn(
        "flex flex-col [&>:is([data-activity-row],[data-thinking],[data-activity])+:is([data-activity-row],[data-thinking],[data-activity])]:-mt-2",
        compact ? "gap-3" : "gap-4",
      )}
    >
      {head && (
        // C1: the head of the turn's activity, in the steps' own row and glyph column; it opens and folds the tool rows.
        // It says how the turn ended: done, stopped ("Stopped after 8s") or failed; a failed step inside keeps its own tone.
        <ActivityRow
          key={headChanged ? head.label : "head"}
          data="head"
          {...(headChanged ? { className: "octo-fade" } : {})}
          state={head.state}
          verb={<span className="tabular-nums">{head.label}</span>}
          {...(toolUses.length > 0 ? { expands: true, open: showSteps, onOpenChange: setStepsOpen } : {})}
        />
      )}
      <Suspense fallback={null}>
        {live && props.plan && <PlanList entries={props.plan} />}
        {live && <ThinkingRow text={props.thinking} after={turn.items.length > 0 || streaming.length > 0} />}
      </Suspense>
      {turn.items.map((item) => {
        if (item.kind === "text") return <Markdown key={item.key} text={item.text} className={prose} fileLinks />;
        if (item.kind === "tools" && !showSteps) return null;
        return (
          <Suspense key={item.key} fallback={null}>
            {item.kind === "tools" ? <ToolGroup uses={item.uses} end={ending} /> : <DelegationGroup uses={item.uses} live={live} end={ending} />}
          </Suspense>
        );
      })}
      {streaming && <Markdown text={streaming} className={prose} streaming fileLinks />}
      {live && props.stopping && <ActivityRow data="stopping" className="octo-fade" state="running" still={!props.watched} verb="Stopping…" />}
      {live && !props.stopping && (
        <ActivityLine agentId={props.agentId} agentName={props.speaker} startedAt={start} now={props.now} watched={props.watched} current={currentStep} />
      )}
      {props.footer && !live && turn.prompt && (
        <Suspense fallback={null}>
          <TurnChanges turnId={turn.prompt.id} />
        </Suspense>
      )}
      {props.footer && !live && reply && turn.lastAt && (
        <TurnFooter reply={reply} at={turn.lastAt} now={props.now} usage={props.usage ?? null} compact={compact} />
      )}
    </article>
  );
});

/** Placeholder elements of each transcript (by an object it holds), by turn key and content signature. */
type Shell = { height: number; sig: string; el: ReactElement };
const shells = new WeakMap<object, Map<string, Shell>>();

const NO_ENDINGS: StoredEndingLookup = () => undefined;

/**
 * B4: each request's ending as the harness stored it (the current session's exchanges: stopped, failed or completed, and how
 * long it worked), read when no turn runs and again when one ends (`refresh`). Nothing without project sessions. The lookup
 * (`lib/storedEndings`) is its own chunk, fetched with the session.
 */
function useStoredEndings(enabled: boolean, refresh: string): { lookup: StoredEndingLookup; settled: boolean } {
  const { bridge } = useApp();
  const { projectId, state } = useProject();
  const sessionId = state.sessions.currentId;
  const [lookup, setLookup] = useState<StoredEndingLookup>(() => NO_ENDINGS);
  // NEW-4: the first answer (or its failure, or the wait running out) lets the turns mount, so a turn's head is laid out once
  // with its stored ending instead of changing ("Stopped after…") under the reader. Later reads never hold the turns back.
  const [loaded, setLoaded] = useState(false);
  // A conversation opened while it works (or without sessions) mounts at once and is never held back later (a turn ending).
  const [unneeded] = useState(() => !enabled || !sessionId || !bridge.getSession);
  useEffect(() => {
    if (!enabled || !sessionId || !bridge.getSession) return;
    let alive = true;
    const done = () => alive && setLoaded(true);
    const wait = window.setTimeout(done, ENDINGS_WAIT_MS);
    Promise.all([bridge.getSession(projectId, sessionId), import("../../lib/storedEndings")])
      .then(
        ([d, m]) => alive && setLookup(() => m.storedEndingLookup(d.exchanges)),
        // Unreadable: the turns keep what the transcript itself says.
        () => undefined,
      )
      .finally(done);
    return () => {
      alive = false;
      window.clearTimeout(wait);
    };
  }, [enabled, sessionId, bridge, projectId, refresh]);
  return { lookup, settled: loaded || unneeded };
}

/** How long the turns wait for the stored endings before they mount without them. */
const ENDINGS_WAIT_MS = 800;

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
      className="-mt-2 -ml-1 flex h-6 min-w-0 items-center gap-1.5 text-xs text-fg-3"
    >
      <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy reply"} size="xs" className="shrink-0" onClick={() => copy(reply)} />
      <time dateTime={at} title={when} className="shrink-0 whitespace-nowrap tabular-nums">
        {timeAgo(at, now)}
      </time>
      {usage && !compact && <span className="min-w-0 truncate whitespace-nowrap tabular-nums">· {usage}</span>}
    </div>
  );
}
