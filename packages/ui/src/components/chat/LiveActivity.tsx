import { useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../../lib/hooks";
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
  now: nowProp,
  watched,
  current = null,
}: {
  agentId: string;
  agentName: string;
  startedAt: number | null;
  now?: number;
  watched: boolean;
  /** The kind of step the newest row above already shows (a streaming "Thinking" row, a running tool group): the line then adds nothing. */
  current?: ActivityLineKind["kind"] | null;
}) {
  // Isolate the 1-second timer inside the live row so ConversationView / Transcript do not re-render every second while streaming.
  const localNow = useNow(nowProp === undefined && watched);
  const now = nowProp ?? localNow;
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

/** Decision 55 e: streamed text is coalesced smoothly onto display frames at most ~once per 32ms. */
export const STREAM_BATCH_MS = 32;

export function useBatched(value: string): string {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  latest.current = value;
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const clearScheduled = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (raf.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(raf.current);
        raf.current = null;
      }
    };
    if (!value) {
      clearScheduled();
      last.current = 0;
      setShown("");
      return;
    }
    if (!shown) {
      clearScheduled();
      last.current = performance.now();
      setShown(value);
      return;
    }
    if (value === shown || timer.current !== null || raf.current !== null) return;
    const commit = () => {
      raf.current = null;
      last.current = performance.now();
      setShown(latest.current);
    };
    const scheduleFrame = () => {
      timer.current = null;
      if (typeof requestAnimationFrame === "function") raf.current = requestAnimationFrame(commit);
      else commit();
    };
    const wait = Math.max(0, STREAM_BATCH_MS - (performance.now() - last.current));
    if (wait <= 4) scheduleFrame();
    else timer.current = window.setTimeout(scheduleFrame, wait);
  }, [value, shown]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (raf.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf.current);
    };
  }, []);

  return value ? shown : "";
}
