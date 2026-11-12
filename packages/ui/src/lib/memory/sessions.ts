import type { MemoryExchange, MemorySession } from "@octo/agent-client";
import { formatDuration, formatSeparator } from "../format";

/** Answers are folded after this many lines (orchestrator memory M4, rule 5). */
export const FOLD_LINES = 12;

export type Folded = { text: string; hidden: number };

/** The first `max` lines of `text` and how many lines were left out (0: nothing is folded). Trailing blank lines do not count. */
export function foldText(text: string, max = FOLD_LINES): Folded {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  // A fence left open by the cut would swallow the rest of the page: close it.
  const head = lines.slice(0, max);
  const open = head.filter((l) => /^\s*(```|~~~)/.test(l)).length % 2 === 1;
  return { text: head.join("\n") + (open ? "\n```" : ""), hidden: lines.length - max };
}

export function filesLabel(n: number): string | null {
  return n === 0 ? null : `${n} ${n === 1 ? "file" : "files"} changed`;
}

export function agentsLabel(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return names.length === 1 ? `1 sub-agent` : `${names.length} sub-agents`;
}

/** "$0.04" or "$0.0012": two decimals from a cent up, four below; null when the harness reported no cost. */
export function formatCost(usd: number | null): string | null {
  if (usd === null) return null;
  if (usd === 0) return "$0";
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** The quiet line under an exchange: when, model, duration, files changed, sub-agents, cost; parts that do not exist are left out. */
export function metaParts(e: MemoryExchange, now: number, locale?: string): string[] {
  const parts = [formatSeparator(e.started_at, now, locale)];
  if (e.model) parts.push(e.model);
  if (e.duration_ms > 0) parts.push(formatDuration(e.duration_ms));
  for (const p of [filesLabel(e.files.length), agentsLabel(e.agents), formatCost(e.cost_usd)]) if (p) parts.push(p);
  return parts;
}

export const STATUS_NOTE: Record<MemoryExchange["status"], string | null> = {
  completed: null,
  failed: "This request failed before it was answered.",
  stopped: "Stopped before it finished.",
};

/** "3 exchanges" / "1 exchange" / "empty" for a session whose exchanges were all forgotten. */
export function exchangeCount(n: number): string {
  return n === 0 ? "empty" : `${n} ${n === 1 ? "exchange" : "exchanges"}`;
}

/** Why a session ended, for its detail header; null when it is open or just went quiet. */
export function endedNote(s: MemorySession): string | null {
  if (s.open) return "Open";
  return s.reason === "clear" ? "Ended with /clear" : s.reason === "rewind" ? "Ended by a rewind" : null;
}

/** Sessions newest first by start (the harness already sends them so; a bridge that does not is corrected). Stable. */
export function newestFirst(sessions: readonly MemorySession[]): MemorySession[] {
  return [...sessions].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}
