import type { Agent, Message } from "@octo/agent-client";
import { Fragment, useMemo } from "react";
import { formatDuration } from "../../lib/format";
import { buildTurns, promptText, type Turn } from "../../lib/transcript";
import { useProject } from "../../state/project";
import { Spinner } from "../primitives/Status";
import { DelegationGroup } from "./DelegationGroup";
import { Markdown } from "./Markdown";
import { ToolGroup } from "./ToolGroup";
import { TranscriptContext, type ToolResult, type TranscriptCtx } from "./transcriptContext";

export function Transcript(props: {
  agent: Agent;
  messages: Message[];
  now: number;
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

  return (
    <TranscriptContext.Provider value={ctx}>
      <div className="flex flex-col gap-6">
        {turns.map((turn, i) => {
          const last = i === turns.length - 1;
          const hidePrompt = props.hideFirstPrompt && i === 0;
          const started = turn.prompt?.created_at ?? (i === 0 ? agent.started_at : null);
          return (
            <Fragment key={turn.key}>
              {turn.prompt && !hidePrompt && (
                <UserPrompt text={promptText(turn.prompt)} author={props.promptAuthor} external={!isOrchestrator} />
              )}
              <AssistantTurn
                turn={turn}
                speaker={props.speaker}
                live={last && running}
                streaming={last ? streaming : ""}
                startedAt={started}
                now={now}
              />
            </Fragment>
          );
        })}
        {turns.length === 0 && running && (
          <AssistantTurn
            turn={{ key: "pending", prompt: null, items: [], lastAt: null }}
            speaker={props.speaker}
            live
            streaming={streaming}
            startedAt={agent.started_at}
            now={now}
          />
        )}
        {lastTurn && lastTurn.status !== "completed" && !running && <TurnBanner status={lastTurn.status} error={lastTurn.error} />}
      </div>
    </TranscriptContext.Provider>
  );
}

function UserPrompt({ text, author, external }: { text: string; author: string; external: boolean }) {
  if (external) {
    return (
      <div className="rounded-lg border border-line px-3.5 py-2.5">
        <div className="mb-0.5 text-xs text-fg-3">From {author}</div>
        <div className="text-sm whitespace-pre-wrap text-fg-2">{text}</div>
      </div>
    );
  }
  return (
    <div className="flex justify-end pl-12">
      <div className="max-w-[85%] rounded-lg bg-raised px-3.5 py-2 text-base whitespace-pre-wrap text-fg">
        <span className="sr-only">{author}: </span>
        {text}
      </div>
    </div>
  );
}

function AssistantTurn(props: {
  turn: Turn;
  speaker: string;
  live: boolean;
  streaming: string;
  startedAt: string | null;
  now: number;
}) {
  const { turn, live, streaming } = props;
  const empty = turn.items.length === 0 && !streaming;
  if (empty && !live) return null;
  const start = props.startedAt ? Date.parse(props.startedAt) : null;
  const end = turn.lastAt ? Date.parse(turn.lastAt) : null;
  const worked = !live && start !== null && end !== null && end - start >= 1000 ? end - start : null;
  return (
    <article aria-label={`${props.speaker} response`} className="flex flex-col">
      {worked !== null && <p className="mb-1.5 text-sm text-fg-3 tabular-nums">Worked for {formatDuration(worked)}</p>}
      {turn.items.map((item) => {
        if (item.kind === "text") return <Markdown key={item.key} text={item.text} className="octo-prose my-1.5" />;
        if (item.kind === "tools") return <ToolGroup key={item.key} uses={item.uses} />;
        return <DelegationGroup key={item.key} uses={item.uses} />;
      })}
      {streaming && <Markdown text={streaming} className="octo-prose my-1.5" streaming />}
      {live && (
        <p className="mt-1.5 flex h-6 items-center gap-2 text-sm text-fg-3 tabular-nums">
          <Spinner />
          Working…{start !== null && <span>{formatDuration(props.now - start)}</span>}
        </p>
      )}
    </article>
  );
}

function TurnBanner({ status, error }: { status: "failed" | "cancelled"; error: string | null }) {
  const failed = status === "failed";
  return (
    <p role="status" className="text-sm text-fg-2">
      <span className={failed ? "text-err" : "text-fg"}>{failed ? "Turn failed." : "Turn stopped."}</span>{" "}
      {error ?? (failed ? "No error details were reported." : "Running agents were cancelled. Send a message to continue.")}
    </p>
  );
}
