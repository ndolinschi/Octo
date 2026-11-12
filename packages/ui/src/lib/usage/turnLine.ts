import type { UsageBucket } from "@octo/agent-client";
import { formatTokens } from "../format";
import { bucketTokens } from "../usage";

/**
 * Decision 86 d: the quiet "model · in / out tokens" a finished turn's meta line gains ("opus · 12k in / 3.1k out").
 * A figure the agent did not report is left out, never shown as 0; null when there is nothing to say. The chat's turn
 * meta calls this with the turn's model name and its usage; this module knows nothing of the chat.
 */
export function turnLine(turn: { model?: string | null; inputTokens?: number | null; outputTokens?: number | null }): string | null {
  const model = turn.model?.trim() || null;
  const parts: string[] = [];
  if (typeof turn.inputTokens === "number") parts.push(`${formatTokens(turn.inputTokens)} in`);
  if (typeof turn.outputTokens === "number") parts.push(`${formatTokens(turn.outputTokens)} out`);
  const tokens = parts.join(" / ");
  if (model && tokens) return `${model} · ${tokens}`;
  return model ?? (tokens || null);
}

/**
 * Decision 86 d: the status bar budget item's tooltip lines, the project's top models by tokens
 * ("opus · 1.2M tokens"). `name` turns a model id into the name shown elsewhere; a bucket without tokens is skipped.
 */
export function topModelLines(buckets: readonly UsageBucket[], name: (id: string) => string = (id) => id, count = 3): string[] {
  return buckets
    .map((b) => ({ label: name(b.label || b.key), tokens: bucketTokens(b) }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label))
    .slice(0, count)
    .map((r) => `${r.label} · ${formatTokens(r.tokens)} tokens`);
}
