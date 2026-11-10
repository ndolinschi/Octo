import type { Agent, Message } from "@octo/agent-client";
import { AlertTriangle, CircleSlash } from "lucide-react";
import { Fragment, useMemo } from "react";
import { cn } from "../../lib/cn";
import { buildTurns, promptText, type Turn } from "../../lib/transcript";
import { useProject } from "../../state/project";
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
  const { agent, messages } = props;
  const { state } = useProject();
  const streaming = state.streaming[agent.id] ?? "";
  const running = agent.status === "running";
  const turns = useMemo(() => buildTurns(messages), [messages]);

  const ctx = useMemo<TranscriptCtx>(() => {
    const results = new Map<string, ToolResult>();
    for (const m of messages) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
    return { results, agentRunning: running, now: props.now };
  }, [messages, running, props.now]);

  const isOrchestrator = agent.parent_id === null;
  const lastTurn = isOrchestrator ? state.lastTurn : null;

  return (
    <TranscriptContext.Provider value={ctx}>
      <div className="flex flex-col gap-7">
        {turns.map((turn, i) => {
          const last = i === turns.length - 1;
          const hidePrompt = props.hideFirstPrompt && i === 0;
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
              />
            </Fragment>
          );
        })}
        {turns.length === 0 && running && (
          <AssistantTurn turn={{ key: "pending", prompt: null, items: [] }} speaker={props.speaker} live streaming={streaming} />
        )}
        {lastTurn && lastTurn.status !== "completed" && !running && (
          <TurnBanner status={lastTurn.status} error={lastTurn.error} />
        )}
      </div>
    </TranscriptContext.Provider>
  );
}

function UserPrompt({ text, author, external }: { text: string; author: string; external: boolean }) {
  if (external) {
    return (
      <div className="rounded-lg border border-line px-4 py-3">
        <div className="mb-1 text-xs font-medium text-fg-3">From {author}</div>
        <div className="text-sm leading-6 whitespace-pre-wrap text-fg-2">{text}</div>
      </div>
    );
  }
  return (
    <div className="flex justify-end pl-16">
      <div className="max-w-[88%] rounded-lg rounded-br-sm bg-user-bubble px-3.5 py-2 text-[14px] leading-6 whitespace-pre-wrap text-fg">
        <span className="sr-only">{author}: </span>
        {text}
      </div>
    </div>
  );
}

function AssistantTurn({ turn, speaker, live, streaming }: { turn: Turn; speaker: string; live: boolean; streaming: string }) {
  const empty = turn.items.length === 0 && !streaming;
  if (empty && !live) return null;
  const lastItem = turn.items[turn.items.length - 1];
  const thinking = live && !streaming && lastItem?.kind !== "delegations" && lastItem?.kind !== "tools";
  return (
    <article aria-label={`${speaker} response`}>
      <div className="mb-2 flex h-5 items-center gap-2">
        <span className={cn("text-xs font-semibold tracking-[0.01em]", live ? "shimmer-text" : "text-fg-2")}>{speaker}</span>
      </div>
      <div className="flex flex-col">
        {turn.items.map((item) => {
          if (item.kind === "text") return <Markdown key={item.key} text={item.text} className="octo-prose my-1.5" />;
          if (item.kind === "tools") return <ToolGroup key={item.key} uses={item.uses} />;
          return <DelegationGroup key={item.key} uses={item.uses} />;
        })}
        {streaming && <Markdown text={streaming} className="octo-prose my-1.5" streaming />}
        {thinking && <p className="shimmer-text my-1 w-fit text-sm">Thinking…</p>}
      </div>
    </article>
  );
}


function TurnBanner({ status, error }: { status: "failed" | "cancelled"; error: string | null }) {
  const failed = status === "failed";
  const Icon = failed ? AlertTriangle : CircleSlash;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2.5 rounded-md border px-3.5 py-2.5 text-sm",
        failed ? "border-err/25 bg-err-soft text-fg" : "border-line text-fg-2",
      )}
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden className={cn("mt-0.5 shrink-0", failed ? "text-err" : "text-fg-3")} />
      <div>
        <span className="font-medium">{failed ? "The turn failed." : "Turn stopped."}</span>{" "}
        <span className="text-fg-2">
          {error ?? (failed ? "No error details were reported." : "Running agents were cancelled. Send a message to continue.")}
        </span>
      </div>
    </div>
  );
}
