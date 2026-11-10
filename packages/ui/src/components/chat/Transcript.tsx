import type { Agent, Message } from "@octo/agent-client";
import { Check, Copy } from "lucide-react";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { formatDuration, formatSeparator, needsSeparator, timeAgo, errorMessage } from "../../lib/format";
import { useCopy } from "../../lib/hooks";
import { splitComments } from "../../lib/comments";
import { buildTurns, promptText, type Turn } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { Button, IconButton } from "../primitives/Button";
import { RunningDot, Spinner } from "../primitives/Status";
import { DelegationGroup } from "./DelegationGroup";
import { Markdown } from "./Markdown";
import { SentComments } from "./SentComments";
import { ToolGroup } from "./ToolGroup";
import { TranscriptContext, type ToolResult, type TranscriptCtx } from "./transcriptContext";

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
}) {
  const { agent, messages, now } = props;
  const { state } = useProject();
  const streaming = state.streaming[agent.id] ?? "";
  const running = agent.status === "running";
  const turns = useMemo(() => buildTurns(messages), [messages]);

  const ctx = useMemo<TranscriptCtx>(() => {
    const results = new Map<string, ToolResult>();
    for (const m of messages) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
    return { results, agentRunning: running, now };
  }, [messages, running, now]);

  const isOrchestrator = agent.parent_id === null;
  const lastTurn = isOrchestrator ? state.lastTurn : null;
  const lastPrompt = turns[turns.length - 1]?.prompt ?? null;
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
          return (
            <section key={turn.key} data-turn-id={turn.prompt?.id} className="flex flex-col gap-4">
              {separator && turn.prompt && <TimeSeparator at={turn.prompt.created_at} now={minute} />}
              {turn.prompt && !hidePrompt && <UserPrompt text={promptText(turn.prompt)} author={props.promptAuthor} external={!isOrchestrator} />}
              <AssistantTurn
                turn={turn}
                speaker={props.speaker}
                live={last && running}
                watched={props.watched}
                streaming={last ? streaming : ""}
                startedAt={started}
                now={last ? now : minute}
                footer={isOrchestrator}
              />
            </section>
          );
        })}
        {turns.length === 0 && running && (
          <AssistantTurn
            turn={{ key: "pending", prompt: null, items: [], lastAt: null }}
            speaker={props.speaker}
            live
            watched={props.watched}
            streaming={streaming}
            startedAt={agent.started_at}
            now={now}
          />
        )}
        {lastTurn && lastTurn.status !== "completed" && !running && (
          <TurnBanner status={lastTurn.status} error={lastTurn.error} retryText={lastPrompt ? promptText(lastPrompt) : null} />
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
const UserPrompt = memo(function UserPrompt({ text: raw, author, external }: { text: string; author: string; external: boolean }) {
  const { prose: text, comments } = useMemo(() => splitComments(raw), [raw]);
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
    <div data-prompt className="rounded-md border border-line bg-raised p-card text-base text-fg transition-[box-shadow] duration-300">
      {external ? <div className="mb-0.5 text-xs text-fg-3">From {author}</div> : <span className="sr-only">{author}: </span>}
      {text && (
        <div ref={box} id={id} className={cn("wrap-anywhere whitespace-pre-wrap", !expanded && "line-clamp-8")}>
          {text}
        </div>
      )}
      {text && (overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((x) => !x)}
          className="mt-1 -ml-1.5 inline-flex h-6 press items-center rounded-sm px-1.5 text-sm text-fg-2 hover:bg-hover hover:text-fg"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {comments.length > 0 && (
        <div className={cn(text && "mt-3")}>
          <SentComments comments={comments} />
        </div>
      )}
    </div>
  );
});

const AssistantTurn = memo(function AssistantTurn(props: {
  turn: Turn;
  speaker: string;
  live: boolean;
  watched: boolean;
  streaming: string;
  startedAt: string | null;
  now: number;
  footer?: boolean;
}) {
  const { turn, live, streaming } = props;
  const empty = turn.items.length === 0 && !streaming;
  if (empty && !live) return null;
  const start = props.startedAt ? Date.parse(props.startedAt) : null;
  const end = turn.lastAt ? Date.parse(turn.lastAt) : null;
  const worked = !live && start !== null && end !== null && end - start >= 1000 ? end - start : null;
  const reply = turn.items.flatMap((item) => (item.kind === "text" ? [item.text] : [])).join("\n\n");
  return (
    // Blocks of a reply (prose, tool lines, delegation cards, the live line, the footer) sit 12 apart.
    <article aria-label={`${props.speaker} response`} className="flex flex-col gap-3">
      {worked !== null && <p className="text-base text-fg-3 tabular-nums">Worked for {formatDuration(worked)}</p>}
      {turn.items.map((item) => {
        if (item.kind === "text") return <Markdown key={item.key} text={item.text} className="octo-prose" fileLinks />;
        if (item.kind === "tools") return <ToolGroup key={item.key} uses={item.uses} />;
        return <DelegationGroup key={item.key} uses={item.uses} />;
      })}
      {streaming && <Markdown text={streaming} className="octo-prose" streaming fileLinks />}
      {live && (
        <p className="flex h-6 items-center gap-2 text-sm text-fg-3 tabular-nums">
          {props.watched ? <Spinner className="text-accent" /> : <RunningDot />}
          Working…{start !== null && <span>{formatDuration(props.now - start)}</span>}
        </p>
      )}
      {props.footer && !live && reply && turn.lastAt && <TurnFooter reply={reply} at={turn.lastAt} now={props.now} />}
    </article>
  );
});

/** Muted row under a finished orchestrator reply: copy it, and when it finished. */
function TurnFooter({ reply, at, now }: { reply: string; at: string; now: number }) {
  const [copied, copy] = useCopy();
  return (
    <div className="-ml-1 flex h-6 items-center gap-1.5 text-sm text-fg-3">
      <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy reply"} size="sm" onClick={() => copy(reply)} />
      <time dateTime={at} title={new Date(at).toLocaleString()} className="tabular-nums">
        {timeAgo(at, now)}
      </time>
    </div>
  );
}

function TurnBanner(props: { status: "failed" | "cancelled"; error: string | null; retryText: string | null }) {
  const { send, running } = useProject();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const failed = props.status === "failed";
  const canRetry = failed && props.retryText !== null;

  const retry = async () => {
    if (!props.retryText) return;
    setBusy(true);
    setRetryError(null);
    try {
      await send(props.retryText);
    } catch (e) {
      setRetryError(errorMessage(e));
      setBusy(false);
    }
  };

  const detail = failed
    ? `${(props.error ?? "No error details were reported").replace(/\.$/, "")}. ${canRetry ? "Retry the last message, or send a new one." : "Send a message to try again."}`
    : "Running agents were cancelled. Send a message to continue.";

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      <p className="min-w-0 flex-1 text-fg-2">
        <span className={failed ? "text-err" : "text-fg"}>{failed ? "Turn failed." : "Turn stopped."}</span> {detail}
        {retryError && <span className="text-err"> Retry failed: {retryError}</span>}
      </p>
      {canRetry && (
        <Button size="sm" onClick={() => void retry()} disabled={busy || running}>
          {busy ? "Retrying…" : "Retry"}
        </Button>
      )}
    </div>
  );
}
