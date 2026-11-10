import type { ContentBlock, Message } from "@octo/agent-client";
import { SPAWN_TOOL } from "./tools";

export type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

export type TranscriptItem =
  | { kind: "text"; key: string; text: string }
  | { kind: "tools"; key: string; uses: ToolUse[] }
  | { kind: "delegations"; key: string; uses: ToolUse[] };

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
      const kind = block.name === SPAWN_TOOL ? "delegations" : "tools";
      const last = items[items.length - 1];
      const sameMessageGroup = last?.kind === "delegations" && last.key.startsWith(`${message.id}.`);
      if (last && last.kind === kind && (kind === "tools" || sameMessageGroup)) {
        last.uses.push(block);
      } else {
        items.push({ kind, key, uses: [block] });
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
