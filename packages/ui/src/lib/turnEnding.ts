import type { ErrorFields } from "@octo/agent-client";
import { formatDuration } from "./format";
import type { Turn, TurnEnd } from "./transcript";

/**
 * How turns and their steps ended, for the transcript's turns, tool lines and delegation cards (all in lazy chunks; the
 * conversation's entry code needs only `lib/transcript`'s turns and requests, so these stay out of the entry bundle).
 */

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
export function isInterruption(result: Result, end: TurnEnd, interrupted = false): boolean {
  if (!result.is_error) return false;
  const text = resultText(result);
  // A failed turn the harness closed after a restart (its exchange is `interrupted`): its own interruption texts are that restart's.
  if (HARNESS_INTERRUPTED.test(text)) return end !== "failed" || interrupted;
  return end === "cancelled" && AGENT_INTERRUPTED.test(text);
}

/**
 * NEW-1: the reason a failed turn holds itself, for a turn whose ending carries no error (an earlier turn after a reload: the
 * harness stores no error with an exchange). The text of the turn's last error result that is not a stop's doing (the
 * harness's interruption texts and an agent's cancel answers say nothing about why it failed); null when there is none.
 * The caller maps it like a live failure (`lib/errors/plain`).
 */
export function turnFailureText(turn: Pick<Turn, "items">, results: ReadonlyMap<string, Result>): string | null {
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i];
    if (item?.kind !== "tools" && item?.kind !== "delegations") continue;
    for (let j = item.uses.length - 1; j >= 0; j--) {
      const r = results.get(item.uses[j]?.id ?? "");
      if (!r?.is_error) continue;
      const text = resultText(r);
      if (text && !HARNESS_INTERRUPTED.test(text) && !AGENT_INTERRUPTED.test(text)) return text;
    }
  }
  return null;
}

export type StepState = "running" | "done" | "error" | "stopped";

/**
 * A tool call's state: no result runs while the agent runs and was stopped otherwise; an error result a stop wrote is stopped,
 * and so is one the harness wrote for a turn a restart interrupted (`interrupted`: the turn's stored exchange says so).
 */
export function stepState(result: Result | undefined, running: boolean, end: TurnEnd, interrupted = false): StepState {
  if (!result) return running ? "running" : "stopped";
  if (!result.is_error) return "done";
  return isInterruption(result, end, interrupted) ? "stopped" : "error";
}

/**
 * The sentence the harness stores for a turn it closed when it started again after stopping mid-turn (a crash, a kill, a
 * restart: `usererr.TurnInterrupted`, the orchestrator row's error and an exchange's `interrupted`).
 */
export const RESTART_INTERRUPTION = "Octo's local service restarted while this request was running.";
/** NEW-9: the harness's hints for that interruption (`usererr.TurnInterrupted`): text was kept, or nothing had been written. */
export const RESTART_KEPT_HINT = "What it had written before the restart is kept. Retry to run the request again.";
export const RESTART_EMPTY_HINT = "Nothing had been written yet. Retry to run the request again.";

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
 * carries the failure as a live one does (`error` the sentence, `fields` its hint and action, `code` the catalogue's code); one
 * the harness closed after a restart is `interrupted`. `keptText`: whether text it had written stays in the conversation.
 */
export type StoredEnding = {
  status: Exclude<TurnEnd, null>;
  startedAt: number;
  ms: number;
  interrupted?: true;
  error?: string;
  fields?: ErrorFields;
  code?: string;
  keptText?: boolean;
};

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
export function spawnStatus(
  agent: Exclude<SpawnStatus, "pending"> | "idle" | undefined,
  result: Result | undefined,
  live: boolean,
  end: TurnEnd,
  interrupted = false,
): SpawnStatus {
  if (agent) return agent === "idle" ? "completed" : agent;
  if (result) return result.is_error ? (isInterruption(result, end, interrupted) ? "cancelled" : "failed") : "completed";
  if (live) return "pending";
  return end === "failed" ? "failed" : "cancelled";
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
