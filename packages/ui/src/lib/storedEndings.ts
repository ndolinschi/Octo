import type { MemoryExchange, Message } from "@octo/agent-client";
import { RESTART_INTERRUPTION, type StoredEnding } from "./transcript";

/*
 * B4, how each request ended as the harness stored it: its own chunk, imported with the session read that needs it (the
 * transcript's stored-endings hook), so the entry does not carry it.
 */

/** The exchanges of a session by the id of the request that started each (`turn_id`); a forgotten one says nothing. */
export function storedEndings(
  exchanges: readonly Pick<MemoryExchange, "turn_id" | "status" | "started_at" | "duration_ms" | "removed" | "interrupted">[],
): Map<number, StoredEnding> {
  const out = new Map<number, StoredEnding>();
  for (const x of exchanges) {
    const startedAt = Date.parse(x.started_at);
    if (!x.turn_id || x.removed || Number.isNaN(startedAt)) continue;
    const ending: StoredEnding = { status: x.status === "stopped" ? "cancelled" : x.status, startedAt, ms: Math.max(0, x.duration_ms) };
    // P1-1: the harness stopped while the turn ran and closed it when it started again.
    out.set(x.turn_id, x.interrupted && x.status === "failed" ? { ...ending, interrupted: true, error: RESTART_INTERRUPTION } : ending);
  }
  return out;
}

/** Ids of two sessions' messages can repeat: an exchange belongs to a prompt only when it also started when the prompt was sent. */
const SAME_START_MS = 2_000;

/** The stored ending of the request `prompt`, or undefined when none matches it. */
export function storedEndingOf(endings: ReadonlyMap<number, StoredEnding>, prompt: Pick<Message, "id" | "created_at"> | null): StoredEnding | undefined {
  if (!prompt) return undefined;
  const e = endings.get(prompt.id);
  return e && Math.abs(e.startedAt - Date.parse(prompt.created_at)) <= SAME_START_MS ? e : undefined;
}

/** What the transcript's hook keeps: the stored ending of a request, looked up in `exchanges`. */
export type StoredEndingLookup = (prompt: Pick<Message, "id" | "created_at"> | null) => StoredEnding | undefined;

/** A lookup over `exchanges` by request: `storedEndingOf` over `storedEndings`. */
export function storedEndingLookup(exchanges: Parameters<typeof storedEndings>[0]): StoredEndingLookup {
  const endings = storedEndings(exchanges);
  return (prompt) => storedEndingOf(endings, prompt);
}
