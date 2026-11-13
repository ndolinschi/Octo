import { formatTokens } from "../format";

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
