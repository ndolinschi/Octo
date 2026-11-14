import type { ContentBlock, Message } from "@octo/agent-client";
import { harnessTool, SPAWN_TOOL } from "./toolName";
import { excerpt, formatDuration } from "./format";

export type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

export type TranscriptItem =
  { kind: "text"; key: string; text: string } | { kind: "tools"; key: string; uses: ToolUse[] } | { kind: "delegations"; key: string; uses: ToolUse[] };

export type Turn = {
  key: string;
  prompt: Message | null;
  items: TranscriptItem[];
  /** created_at of the last message in the turn (assistant or tool result). */
  lastAt: string | null;
};

function userText(message: Message): string | null {
  const parts = message.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  return parts.length ? parts.join("\n\n") : null;
}

export function promptText(message: Message): string {
  return userText(message) ?? "";
}

export function buildTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      if (userText(message) === null) {
        if (current) current.lastAt = message.created_at;
        continue;
      }
      current = { key: `t${message.id}`, prompt: message, items: [], lastAt: null };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { key: `t0-${message.id}`, prompt: null, items: [], lastAt: null };
      turns.push(current);
    }
    current.lastAt = message.created_at;
    const items = current.items;
    message.content.forEach((block, i) => {
      const key = `${message.id}.${i}`;
      if (block.type === "text") {
        if (block.text.trim()) items.push({ kind: "text", key, text: block.text });
        return;
      }
      if (block.type !== "tool_use") return;
      // An MCP-prefixed harness tool (an ACP orchestrator's `mcp__octo-harness__spawn_agent`) is the built-in one.
      const name = harnessTool(block.name);
      const use = name === block.name ? block : { ...block, name };
      const kind = name === SPAWN_TOOL ? "delegations" : "tools";
      const last = items[items.length - 1];
      const sameMessageGroup = last?.kind === "delegations" && last.key.startsWith(`${message.id}.`);
      if (last && last.kind === kind && (kind === "tools" || sameMessageGroup)) {
        last.uses.push(use);
      } else {
        items.push({ kind, key, uses: [use] });
      }
    });
  }
  return turns;
}

/** How a finished turn ended; null while it runs or when nothing says (an earlier turn after a reload). */
export type TurnEnd = "completed" | "failed" | "cancelled" | null;
type Result = { content: unknown; is_error: boolean };

/**
 * The results the harness writes for a call a stop cut short (apps/harness/internal/orchestrator): the built-in loop's
 * `interruptedResult` (history.go, stored before the next request for a call left without a result) and an ACP
 * orchestrator's close of a call still open when its turn ended in an error or a cancel (acp_session.go `finishLocked`).
 */
const HARNESS_INTERRUPTED = /^(interrupted: the tool call did not complete|the agent stopped before this tool call finished)\.?$/i;
/** What an ACP agent itself answers for the call `session/cancel` interrupted ("rejected" from Claude Code, and the like). */
const AGENT_INTERRUPTED = /^(rejected|cancell?ed|interrupted)\b|tool use was rejected|interrupted by (the )?user/i;

const resultText = (r: Result) => (typeof r.content === "string" ? r.content.trim() : "");

/**
 * Whether an error result is a stop's doing rather than a failure: the harness's own interruption texts unless the turn is
 * known to have failed; an agent's cancel answer only in a turn that was stopped.
 */
export function isInterruption(result: Result, end: TurnEnd): boolean {
  if (!result.is_error) return false;
  const text = resultText(result);
  if (HARNESS_INTERRUPTED.test(text)) return end !== "failed";
  return end === "cancelled" && AGENT_INTERRUPTED.test(text);
}

export type StepState = "running" | "done" | "error" | "stopped";

/** A tool call's state: no result runs while the agent runs and was stopped otherwise; an error result a stop wrote is stopped. */
export function stepState(result: Result | undefined, running: boolean, end: TurnEnd): StepState {
  if (!result) return running ? "running" : "stopped";
  if (!result.is_error) return "done";
  return isInterruption(result, end) ? "stopped" : "error";
}

/**
 * The sentence the harness stores for a turn it closed when it started again after stopping mid-turn (a crash, a kill, a
 * restart: `usererr.TurnInterrupted`, the orchestrator row's error and an exchange's `interrupted`).
 */
export const RESTART_INTERRUPTION = "Octo's local service restarted while this request was running.";

/** Whether a turn error is the harness's restart interruption (the latest turn after a reload carries only the row's text). */
export function isRestartInterruption(error: string | null | undefined): boolean {
  return (error ?? "").trim() === RESTART_INTERRUPTION;
}

/**
 * The head row of a finished turn ("Worked for 8s"): a stopped turn says "Stopped after 8s" with the stopped glyph, a
 * failed one "Failed after 8s" with the failed glyph, a failed one the harness closed after a restart (its stored ending is
 * `interrupted`) "Interrupted after 8s — Octo's local service restarted". An unknown ending with a stopped step reads as
 * stopped (the harness writes an interruption result only after a cancel or a crash).
 */
export function turnHead(
  end: TurnEnd,
  ms: number,
  steps: readonly StepState[] = [],
  stored?: Pick<StoredEnding, "interrupted">,
): { state: "done" | "failed" | "stopped"; label: string } {
  const ending = end ?? (steps.includes("stopped") ? "cancelled" : "completed");
  const time = formatDuration(ms);
  if (stored?.interrupted && ending === "failed") return { state: "failed", label: `Interrupted after ${time} — Octo's local service restarted` };
  if (ending === "cancelled") return { state: "stopped", label: `Stopped after ${time}` };
  if (ending === "failed") return { state: "failed", label: `Failed after ${time}` };
  return { state: "done", label: `Worked for ${time}` };
}

/**
 * How a request ended as the harness stored it (its exchange): status, start and duration (`lib/storedEndings`); a failed one
 * the harness closed after a restart is `interrupted`, with the sentence of that ending as `error`.
 */
export type StoredEnding = { status: Exclude<TurnEnd, null>; startedAt: number; ms: number; interrupted?: true; error?: string };

/**
 * How long a finished turn worked (B4), to the turn's end rather than to its last item (a stop or a failure can come long after
 * the last message): the stored exchange's duration; else, for the agent's latest turn, the agent's `finished_at` (it is set
 * when the turn ends, live and after a reload); else the last message. Null while it runs or when nothing says.
 */
export function turnDurationMs(
  start: number | null,
  opts: { live: boolean; lastAt: string | null; finishedAt?: string | null | undefined; stored?: StoredEnding | undefined },
): number | null {
  if (opts.live || start === null) return null;
  if (opts.stored) return opts.stored.ms;
  const finished = opts.finishedAt ? Date.parse(opts.finishedAt) : NaN;
  const last = opts.lastAt ? Date.parse(opts.lastAt) : NaN;
  const end = !Number.isNaN(finished) && finished >= start ? Math.max(finished, Number.isNaN(last) ? finished : last) : last;
  return Number.isNaN(end) ? null : end - start;
}

export type SpawnStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * A delegation row's status. With its agent, the agent's own; without one (the call failed before the agent was created,
 * or the turn ended first) it comes from the call's result: an error is failed (or stopped when a stop wrote it), a
 * success is completed; no result is pending only while the turn runs, then failed in a failed turn and stopped otherwise.
 * A finished turn never leaves a spinner.
 */
export function spawnStatus(agent: Exclude<SpawnStatus, "pending"> | "idle" | undefined, result: Result | undefined, live: boolean, end: TurnEnd): SpawnStatus {
  if (agent) return agent === "idle" ? "completed" : agent;
  if (result) return result.is_error ? (isInterruption(result, end) ? "cancelled" : "failed") : "completed";
  if (live) return "pending";
  return end === "failed" ? "failed" : "cancelled";
}

export type RequestState = "done" | "working" | "failed" | "stopped";

/** One user request of a conversation, for the turn rail and the floating composer's status chip. */
export type RequestSummary = { id: number; text: string; state: RequestState; startedAt: number; endedAt: number | null };

/**
 * The requests of a conversation with their state: the last one is working while the agent runs, failed
 * or stopped when the last turn ended so; earlier ones are done, lasting from the prompt to their last message.
 */
export function requestSummaries(turns: Turn[], running: boolean, lastTurn: "completed" | "failed" | "cancelled" | null): RequestSummary[] {
  const out: RequestSummary[] = [];
  turns.forEach((t, i) => {
    if (!t.prompt) return;
    const last = i === turns.length - 1;
    const state: RequestState = last && running ? "working" : last && lastTurn === "failed" ? "failed" : last && lastTurn === "cancelled" ? "stopped" : "done";
    out.push({
      id: t.prompt.id,
      text: promptText(t.prompt),
      state,
      startedAt: Date.parse(t.prompt.created_at),
      endedAt: state === "working" || !t.lastAt ? null : Date.parse(t.lastAt),
    });
  });
  return out;
}

/**
 * The first prose line of the orchestrator's latest reply, as plain text (Home's project list, decision 23): headings,
 * tables, code blocks, rules and quotes are skipped; list items count without their marker. Null when the latest reply
 * has no prose line (nothing is shown then, rather than a heading fragment).
 */
export function latestReply(messages: readonly Message[]): { text: string; at: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (!text.trim()) continue;
    const line = firstProseLine(text);
    return line ? { text: line, at: m.created_at } : null;
  }
  return null;
}

function firstProseLine(markdown: string): string | null {
  let fence = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || !line) continue;
    // Headings, table rows and separators, rules, quotes, HTML: not prose.
    if (/^(#{1,6}\s|\||[-*_]{3,}$|>|<)/.test(line)) continue;
    const prose = excerpt(line.replace(/^([-*+]|\d+[.)])\s+/, ""), 160);
    if (prose && /[\p{L}\p{N}]/u.test(prose)) return prose;
  }
  return null;
}

/**
 * Where "History compacted" markers go (decision 37): a marker covers every message up to `upto`, so it is drawn before
 * the first turn whose prompt comes after that message. Returns, per turn index, the markers drawn before it; markers
 * past the last turn's prompt go under index `promptIds.length` (after the transcript). Turns without a prompt keep
 * their place (null id).
 */
export function compactionSlots<T extends { upto_message_id: number }>(promptIds: readonly (number | null)[], markers: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const m of markers) {
    let at = promptIds.findIndex((id) => id !== null && id > m.upto_message_id);
    if (at < 0) at = promptIds.length;
    out.set(at, [...(out.get(at) ?? []), m]);
  }
  return out;
}

/** A `warning:`-prefixed turn error (an ACP orchestrator without harness tools) as a sentence; null for anything else. */
export function turnWarning(error: string | null | undefined): string | null {
  if (!error || !/^warning:\s*/i.test(error)) return null;
  const text = error.replace(/^warning:\s*/i, "").trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : null;
}

/** Decision 57: the request rail appears from five requests (fewer are all on screen or one scroll away). */
export const RAIL_MIN_REQUESTS = 5;
export function showRail(requests: number): boolean {
  return requests >= RAIL_MIN_REQUESTS;
}
