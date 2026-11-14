import { useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../../state/project";
import { ActivityRow } from "./ActivityRow";
import { activityLine, type ActivityLine as ActivityLineKind, labelParts, runningToolOf } from "./activity";
import { useAnimationGate } from "./useAnimationGate";

/**
 * The activity line (decision 55 a): what the agent is doing now — "Thinking…", "Reading src/x.ts", "Running `pnpm
 * test`", "Still working — no output from Claude Code yet" — with the timer, and the shimmer of decision 45 b while the
 * conversation is watched. Labels come from `agent.activity`, else from the transcript (the running tool row).
 */
export function ActivityLine({
  agentId,
  agentName,
  startedAt,
  now,
  watched,
  current = null,
}: {
  agentId: string;
  agentName: string;
  startedAt: number | null;
  now: number;
  watched: boolean;
  /** The kind of step the newest row above already shows (a streaming "Thinking" row, a running tool group): the line then adds nothing. */
  current?: ActivityLineKind["kind"] | null;
}) {
  const { state } = useProject();
  const messages = state.messages[agentId];
  const streaming = state.streaming[agentId] ?? "";
  const thinking = state.thinking[agentId] ?? "";
  const activity = state.activity[agentId];
  const waitingOn = state.agentOrder.flatMap((id) => {
    const a = state.agents[id];
    return a?.parent_id === agentId && a.status === "running" ? [a.role] : [];
  });
  // Any change of these is a sign of life; ten quiet seconds are said (decision 55 e).
  const signal = `${messages?.length ?? 0}|${streaming.length}|${thinking.length}|${activity?.kind}|${activity?.label}|${waitingOn.length}`;
  const [seen, setSeen] = useState({ signal, at: now });
  if (seen.signal !== signal) setSeen({ signal, at: now });
  const running = useMemo(() => (messages ? runningToolOf(messages) : null), [messages]);
  const line = activityLine({
    activity,
    runningTool: running,
    writing: streaming.length > 0,
    thinking: thinking.length > 0,
    waitingOn,
    quietMs: now - seen.at,
    agentName,
  });
  const ref = useRef<HTMLParagraphElement>(null);
  const paused = useAnimationGate(ref, watched);
  if (current !== null && line.kind === current) return null;
  const parts = labelParts(line.label);
  const text = parts.map((p, i) =>
    p.code ? (
      <code key={i} className="font-mono text-xs">
        {p.text}
      </code>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
  return (
    <div ref={ref} data-activity={line.kind} data-paused={paused || undefined} className="tabular-nums">
      <ActivityRow
        state="running"
        verb={
          watched ? (
            <span className="octo-shimmer" title={line.label}>
              {text}
              <span aria-hidden className="octo-shimmer-sweep">
                <span className="octo-shimmer-text">{text}</span>
              </span>
            </span>
          ) : (
            <span title={line.label}>{text}</span>
          )
        }
        duration={startedAt !== null ? now - startedAt : null}
      />
    </div>
  );
}

/** Decision 55 e: streamed text is shown at most every 50 ms, never more often (a burst of deltas is one render). */
export const STREAM_BATCH_MS = 50;

export function useBatched(value: string): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (value === shown) return;
    // Cleared (a finished reply), or the first text: show it at once.
    if (!value || !shown) {
      last.current = performance.now();
      setShown(value);
      return;
    }
    const wait = Math.max(0, STREAM_BATCH_MS - (performance.now() - last.current));
    const id = window.setTimeout(() => {
      last.current = performance.now();
      setShown(value);
    }, wait);
    return () => window.clearTimeout(id);
  }, [value, shown]);
  return value ? shown : "";
}
