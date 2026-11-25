import type { ErrorAction, ErrorFields, MemoryExchange, Message } from "@octo/agent-client";
import { RESTART_EMPTY_HINT, RESTART_INTERRUPTION, RESTART_KEPT_HINT, type StoredEnding } from "./turnEnding";

/*
 * B4, how each request ended as the harness stored it: its own chunk, imported with the session read that needs it (the
 * transcript's stored-endings hook), so the entry does not carry it.
 */

type StoredExchange = Pick<MemoryExchange, "turn_id" | "status" | "started_at" | "duration_ms" | "removed" | "interrupted" | "error" | "kept_text">;

/**
 * NEW-1: the button a stored failure asks for. The harness keeps a failure's code, message and hint with its exchange but not
 * its `action` (usererr catalogue): the codes whose action is not "retry" are named here, every other failure retries, as
 * it did live.
 */
const ACTION_BY_CODE: Record<string, ErrorAction | null> = {
  agent_not_logged_in: "recheck_provider",
  agent_not_installed: "recheck_provider",
  agent_silent: "recheck_provider",
  provider_not_working: "recheck_provider",
  agent_launch_rejected: "update_agent",
  agent_tool_server_refused: "update_agent",
  agent_model_rejected: "open_settings",
  agent_unavailable: "open_settings",
  provider_not_supported: "open_settings",
  budget_reached: "open_settings",
  images_unsupported: "open_settings",
  command_problem: "open_settings",
  no_provider: "connect_provider",
  provider_not_connected: "connect_provider",
  api_key_rejected: "connect_provider",
  builtin_loop_unavailable: "connect_provider",
  newer_schema: null,
  turn_in_progress: null,
};

/** A stored failure in the shape a live one has (`TurnOutcome`'s `error` and fields): its message, hint and action. */
function storedFailure(x: StoredExchange): Pick<StoredEnding, "error" | "fields" | "code"> | null {
  if (x.status !== "failed") return null;
  if (x.error?.message) {
    const fields: ErrorFields = {};
    if (x.error.hint) fields.hint = x.error.hint;
    const action = x.error.code in ACTION_BY_CODE ? ACTION_BY_CODE[x.error.code] : "retry";
    if (action) fields.action = action;
    return { error: x.error.message, fields, ...(x.error.code ? { code: x.error.code } : {}) };
  }
  // An exchange recorded before the harness kept errors: only a restart's interruption is known, its hint from `kept_text`.
  if (!x.interrupted) return null;
  const hint = x.kept_text === true ? RESTART_KEPT_HINT : x.kept_text === false ? RESTART_EMPTY_HINT : undefined;
  return { error: RESTART_INTERRUPTION, fields: { action: "retry", ...(hint ? { hint } : {}) } };
}

/** The exchanges of a session by the id of the request that started each (`turn_id`); a forgotten one says nothing. */
export function storedEndings(exchanges: readonly StoredExchange[]): Map<number, StoredEnding> {
  const out = new Map<number, StoredEnding>();
  for (const x of exchanges) {
    const startedAt = Date.parse(x.started_at);
    if (!x.turn_id || x.removed || Number.isNaN(startedAt)) continue;
    const ending: StoredEnding = { status: x.status === "stopped" ? "cancelled" : x.status, startedAt, ms: Math.max(0, x.duration_ms) };
    // P1-1: the harness stopped while the turn ran and closed it when it started again.
    if (x.interrupted && x.status === "failed") ending.interrupted = true;
    if (x.kept_text !== undefined) ending.keptText = x.kept_text;
    const failure = storedFailure(x);
    out.set(x.turn_id, failure ? { ...ending, ...failure } : ending);
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

/**
 * A lookup over `exchanges` by request: `storedEndingOf` over `storedEndings`. Several sessions' exchanges (a transcript that
 * shows messages of more than one session) are looked up in turn: the first whose exchange matches the prompt's start wins.
 */
export function storedEndingLookup(...sessions: readonly (readonly StoredExchange[])[]): StoredEndingLookup {
  const all = sessions.map((exchanges) => storedEndings(exchanges));
  return (prompt) => {
    for (const endings of all) {
      const hit = storedEndingOf(endings, prompt);
      if (hit) return hit;
    }
    return undefined;
  };
}
