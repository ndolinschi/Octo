import type { QueuedMessage } from "@octo/agent-client";

/** The harness keeps at most 20 queued messages (`409 queue_full`). */
export const QUEUE_MAX = 20;
/** Past this many rows the list folds behind "N queued" (v7 §2). */
export const QUEUE_FOLD_AFTER = 3;

/** One line for a queued message: its first non-empty line, inner whitespace collapsed. */
export function queueLine(text: string): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return first.replace(/\s+/g, " ").trim();
}

/** Rows shown and how many are folded: everything while expanded or up to the fold, else the first two plus a fold row. */
export function queueView<T>(messages: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || messages.length <= QUEUE_FOLD_AFTER) return { shown: [...messages], hidden: 0 };
  const shown = messages.slice(0, QUEUE_FOLD_AFTER - 1);
  return { shown, hidden: messages.length - shown.length };
}

export function queueCountLabel(n: number): string {
  return `${n} queued`;
}

/** The queue after an optimistic removal; the next `queue.updated` replaces it either way. */
export function withoutQueued(messages: readonly QueuedMessage[], id: string): QueuedMessage[] {
  return messages.filter((m) => m.id !== id);
}

export function queueFull(count: number): boolean {
  return count >= QUEUE_MAX;
}
