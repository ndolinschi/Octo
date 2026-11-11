import type { ContentBlock, Message } from "@octo/agent-client";
import { harnessTool, SPAWN_TOOL } from "./tools";
import { excerpt } from "./format";

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
