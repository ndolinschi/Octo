import type { MemoryExchange, MemorySession } from "@octo/agent-client";
import { formatDuration, formatSeparator } from "../format";
import { formatDay, formatWhen } from "./dates";

/** "3 exchanges" / "1 exchange" / "empty" for a session whose exchanges were all forgotten. */
export function exchangeCount(n: number): string {
  return n === 0 ? "empty" : `${n} ${n === 1 ? "exchange" : "exchanges"}`;
}

/** What a session row says (decision 93 d): the title, "Nov 12 · 5 exchanges", and whether it is the one in use. */
export type SessionRow = { title: string; description: string; current: boolean; working: boolean };

/**
 * `currentId` is the project's current main session from the session entity (`state.sessions.currentId`); while the
 * entity is not loaded (null) the memory session's own `open` flag says it. `orchestratorWorking` applies to the current one.
 */
export function sessionRow(s: MemorySession, now: number, orchestratorWorking: boolean, currentId: string | null = null): SessionRow {
  const current = currentId === null ? s.open : s.id === currentId;
  return {
    title: s.title,
    description: `${formatDay(s.started_at, now)} · ${exchangeCount(s.exchanges)}`,
    current,
    working: current && orchestratorWorking,
  };
}

/** Why a session ended, for its header; null when it is open or just went quiet. */
export function endedNote(s: MemorySession): string | null {
  if (s.open) return null;
  return s.reason === "clear" ? "Ended with /clear" : s.reason === "rewind" ? "Ended by a rewind" : null;
}

/** Sessions newest first by start (the harness already sends them so; a bridge that does not is corrected). Stable. */
export function newestFirst(sessions: readonly MemorySession[]): MemorySession[] {
  return [...sessions].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

/** The first non-empty line of a request, whitespace collapsed: what the row shows. */
export function requestLine(request: string): string {
  const line = request.split("\n").find((l) => l.trim() !== "");
  return (line ?? "").replace(/\s+/g, " ").trim();
}

/** The expanded view repeats the request only when the row could not show all of it. */
export const REQUEST_ROW_CHARS = 90;
export function needsFullRequest(request: string): boolean {
  const t = request.trim();
  return t.includes("\n") || t.length > REQUEST_ROW_CHARS;
}

/** The first line of prose in an answer, without Markdown marks, code fences or tables: the dim line under a request. */
export function answerPreview(answer: string): string {
  let fenced = false;
  for (const raw of answer.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line === "" || line.startsWith("|") || /^[-*_]{3,}$/.test(line)) continue;
    const plain = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^([-*+]|\d+[.)])\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|\*|`)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain !== "") return plain;
  }
  return "";
}

export type Outcome = "done" | "failed" | "stopped";

export const OUTCOME_LABEL: Record<Outcome, string> = { done: "Answered", failed: "Failed", stopped: "Stopped" };

export function outcomeOf(e: Pick<MemoryExchange, "status">): Outcome {
  return e.status === "completed" ? "done" : e.status;
}

/** The row of a collapsed exchange: request on one line, dim answer line under it, time at the right, outcome glyph. */
export type ExchangeRow = { title: string; description: string; when: string; outcome: Outcome };

export function exchangeRow(e: MemoryExchange, now: number): ExchangeRow {
  const outcome = outcomeOf(e);
  const preview = answerPreview(e.answer);
  const fallback = outcome === "failed" ? "Failed before an answer" : outcome === "stopped" ? "Stopped before an answer" : "No answer text";
  return { title: requestLine(e.request) || "Empty request", description: preview || fallback, when: formatWhen(e.started_at, now), outcome };
}

/** The sentence under an expanded failed or stopped exchange, with the next step (rule 20); null when it went well. */
export function statusNote(status: MemoryExchange["status"]): string | null {
  if (status === "failed") return "This request failed before it was answered. Open it in the conversation to see why or send it again.";
  if (status === "stopped") return "Stopped before it finished. What it had written so far is above.";
  return null;
}

export function filesLabel(n: number): string | null {
  return n === 0 ? null : `${n} ${n === 1 ? "file" : "files"}`;
}

/** "$0.04" or "$0.0012": two decimals from a cent up, four below; null when the harness reported no cost. */
export function formatCost(usd: number | null): string | null {
  if (usd === null) return null;
  if (usd === 0) return "$0";
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * The parts of the one meta line, in the order they give way: time, model, duration, files, cost. The line is cut from
 * the right (CSS ellipsis), so the cost goes first. A part that does not exist is left out, so no separator can start
 * or end the line. `model` is the readable name, never the raw id.
 */
export function metaParts(e: Pick<MemoryExchange, "started_at" | "duration_ms" | "files" | "cost_usd">, model: string, now: number, locale?: string): string[] {
  const parts = [
    formatSeparator(e.started_at, now, locale),
    model,
    e.duration_ms > 0 ? formatDuration(e.duration_ms) : "",
    filesLabel(e.files.length) ?? "",
    formatCost(e.cost_usd) ?? "",
  ];
  return parts.filter((p) => p !== "");
}

export const META_SEPARATOR = " · ";
export const metaLine = (parts: readonly string[]): string => parts.join(META_SEPARATOR);

/** One exchange open at a time (decision 93 d): choosing the open one closes it, choosing another replaces it. */
export function toggleExpanded(current: string | null, id: string): string | null {
  return current === id ? null : id;
}
