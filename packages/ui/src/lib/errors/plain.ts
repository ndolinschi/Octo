import type { ErrorAction, ErrorFields } from "@octo/agent-client";
import { agentLabelOf, JARGON } from "./words";

export { agentLabelOf, JARGON };

/**
 * Decision 94b: every failure the person reads is one plain sentence, a next step, and the technical text for a
 * "Details" fold. This module knows the codes and texts the harness and the agents produce and maps them; anything
 * unknown becomes its first sentence with the protocol vocabulary stripped. Nothing it returns contains ACP, MCP,
 * "exit status", stderr, JSON-RPC, a `method/name`, or a tool id (the test checks that over every string it can produce).
 */

/** What the person can do next. `command` is a line to copy; `check` re-reads the agent's login state; `retry` sends again. */
export type NextStep = { kind: "check" } | { kind: "retry" } | { kind: "command"; command: string };

export type PlainError = {
  /** One sentence, ends with a full stop. */
  sentence: string;
  next: NextStep | null;
  /** The original text, for the fold. Empty when there was none. */
  details: string;
  /** The next step in plain words, when the harness (or the mapping) gave one. */
  hint?: string;
  /** The button the harness asked for (decision 94b); set only for a structured failure. */
  action?: ErrorAction;
};

/** A failure as the harness sends it: the plain `message` first, then `hint`, `command`, `action`, `details`. */
export type Structured = { message: string } & ErrorFields;

const ACTION_NEXT: Record<ErrorAction, (command: string | undefined) => NextStep | null> = {
  recheck_provider: () => ({ kind: "check" }),
  connect_provider: () => null,
  retry: () => ({ kind: "retry" }),
  open_settings: () => null,
  update_agent: () => null,
};

/**
 * The failure the harness described itself: its `message` is the sentence (never `details`, which only feeds the fold),
 * its `action` picks the button. Only an old harness, which sends the bare text, goes through `plainError`.
 */
export function plainStructured(f: Structured): PlainError {
  const command = f.command ?? commandOf(f.hint) ?? undefined;
  const next: NextStep | null = command ? { kind: "command", command } : f.action ? ACTION_NEXT[f.action](f.command) : null;
  const out: PlainError = { sentence: /[.!?]$/.test(f.message) ? f.message : `${f.message}.`, next, details: f.details ?? "" };
  if (f.hint) out.hint = f.hint;
  if (f.action) out.action = f.action;
  return out;
}

/** True when `fields` carry a structured failure (a harness of decision 94b); false for the bare text of an older one. */
export function isStructured(f: (Partial<Structured> & ErrorFields) | null | undefined): f is Structured {
  if (!f || typeof f.message !== "string" || f.message === "" || JARGON.test(f.message)) return false;
  return !!f.hint || !!f.action || !!f.command || !!f.details || f.message.endsWith(".");
}

const THE_AGENT = "The agent";

const has = (s: string, ...words: string[]) => words.some((w) => s.toLowerCase().includes(w));

/** The login command in a hint ("Run `copilot auth login` in a terminal"): the backticked part, else null. */
export function commandOf(hint: string | null | undefined): string | null {
  const m = /`([^`]+)`/.exec(hint ?? "");
  return m?.[1]?.trim() || null;
}

/** First sentence of `text`, with protocol vocabulary taken out in favour of plain words. */
export function stripJargon(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  const out = first
    .replace(/\bACP (agent|server)\b/gi, "agent")
    .replace(/\bACP\b/g, "agent")
    .replace(/\bMCP (server|tool)s?\b/gi, "tool server")
    .replace(/\bMCP\b/g, "tool")
    .replace(/\bJSON-?RPC\b/gi, "")
    .replace(/\([^()]*\b(?:exit status|exit code|stderr|stdout|method not supported)\b[^()]*\)/gi, "")
    .replace(/[:,;]?\s*exit(?:ed)? (?:with )?(?:status|code) \d+/gi, "")
    .replace(/\bstd(?:err|out)\b:?/gi, "")
    .replace(/\b[a-z_]+\/[a-z_]+\b/gi, "")
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/^[\s:;,.-]+|[\s:;,-]+$/g, "")
    .trim();
  if (!out) return "";
  const capped = `${out.charAt(0).toUpperCase()}${out.slice(1)}`;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

type Ctx = { agent?: string | undefined; hint?: string | null | undefined };

function loginSentence(c: Ctx): Pick<PlainError, "sentence" | "next" | "action"> {
  const command = commandOf(c.hint);
  return { sentence: `${c.agent ?? THE_AGENT} is not logged in.`, next: command ? { kind: "command", command } : { kind: "check" } };
}

/** Codes the harness sends, as sentences. */
const BY_CODE: Record<string, (c: Ctx) => Pick<PlainError, "sentence" | "next" | "action">> = {
  images_unsupported: (c) => ({ sentence: `${c.agent ?? "This model"} can't read images. Your message is still in the box.`, next: null }),
  acp_not_logged_in: loginSentence,
  not_logged_in: loginSentence,
  turn_in_progress: () => ({ sentence: "A turn is still running. Wait for it or stop it first.", next: null }),
  rate_limited: () => ({ sentence: "The model is busy right now. Try again in a moment.", next: { kind: "retry" } }),
  unauthorized: () => ({ sentence: "The provider did not accept the key. Check it in Settings.", next: null, action: "open_settings" }),
  no_api_key: () => ({ sentence: "No model is connected yet. Connect one in Settings.", next: null, action: "open_settings" }),
  context_too_long: () => ({ sentence: "The conversation is too long for this model. Compact it or start a new one.", next: null }),
};

/** Maps a failure to its plain form. `code` is the typed error code when there is one, `raw` the message text. */
export function plainError(raw: string | null | undefined, ctx: Ctx & { code?: string | null | undefined } = {}): PlainError {
  const text = (raw ?? "").trim();
  const details = text;
  const name = ctx.agent ?? THE_AGENT;
  const byCode = ctx.code ? BY_CODE[ctx.code] : undefined;
  if (byCode) return { ...byCode(ctx), details };
  const known = (sentence: string, next: NextStep | null): PlainError => ({ sentence, next, details });
  if (!text) return known("Something went wrong, and no reason was reported.", { kind: "retry" });
  if (has(text, "refused the harness", "ran without harness tools"))
    return known(`${name} ran this request without Octo's own tools (agents, notes, plans).`, null);
  if (has(text, "not logged in", "login required", "please log in", "unauthenticated", "auth login")) return { ...loginSentence(ctx), details };
  if (has(text, "could not start", "failed to start", "spawn ", "enoent", "not found in path", "command not found"))
    return known(`${name} could not start. Check that it is installed.`, { kind: "check" });
  if (has(text, "rate limit", "429", "overloaded", "too many requests")) return known("The model is busy right now. Try again in a moment.", { kind: "retry" });
  if (has(text, "invalid api key", "invalid x-api-key", "incorrect api key", "api key was rejected", "provider key", "authentication_error"))
    return { ...known("The provider did not accept the key. Check it in Settings.", null), action: "open_settings" };
  if (has(text, "timed out", "timeout", "deadline exceeded")) return known(`${name} took too long to answer.`, { kind: "retry" });
  if (has(text, "context length", "context window", "too many tokens", "prompt is too long"))
    return known("The conversation is too long for this model. Compact it or start a new one.", null);
  if (has(text, "exit status", "exited", "broken pipe", "connection closed", "eof", "crashed", "signal: killed"))
    return known(`${name} stopped unexpectedly.`, { kind: "retry" });
  if (has(text, "connection refused", "network", "dns", "offline", "failed to fetch"))
    return known("Could not reach the model. Check the connection and try again.", { kind: "retry" });
  const first = stripJargon(text);
  return known(first && !JARGON.test(first) ? first : "Something went wrong.", { kind: "retry" });
}

/** Every fixed string this module can produce, for the test that none contains jargon. */
export function allPlainStrings(): string[] {
  const out: string[] = [];
  for (const f of Object.values(BY_CODE)) out.push(f({}).sentence, f({ agent: "Claude Code", hint: "Run `x login`." }).sentence);
  return out;
}

/**
 * A stored failure text (an agent row's `error`, a project's attention) as one readable sentence: the harness's own plain
 * message stays as it is; a text with protocol words (an older harness, or a hand-written demo) goes through the mapping.
 */
export function readable(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  return JARGON.test(text) ? plainError(text).sentence : text;
}
