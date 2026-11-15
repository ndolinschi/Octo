import type { ContextReceipt, ReceiptBlock } from "@octo/agent-client";
import { formatTokens } from "../format";

const LABEL: Record<string, string> = {
  memory_index: "Memory index",
  open_tasks: "Open tasks",
  recent_window: "Recent requests",
  facts: "Facts",
  current_turn: "This request",
  history: "Whole history",
  changed_tasks: "Changed tasks",
};

/** A block's name as people read it; an unknown name (a newer harness) is shown as sent, underscores spaced. */
export function blockLabel(name: string): string {
  return LABEL[name] ?? name.replace(/_/g, " ");
}

/** One of the `--octo-ctx-*` colours per block, so the bar needs no new hues. */
const COLOR: Record<string, string> = {
  memory_index: "notes",
  open_tasks: "summary",
  recent_window: "messages",
  facts: "tool_results",
  current_turn: "tools",
  history: "messages",
  changed_tasks: "summary",
};

export function blockColor(name: string): string {
  return `var(--octo-ctx-${COLOR[name] ?? "other"})`;
}

export type BarSegment = {
  name: string;
  label: string;
  tokens: number;
  /** Share of the receipt's total, 0 to 1. */
  share: number;
  cap: number;
  /** tokens / cap, 0 to 1; null for a block without a cap. */
  fill: number | null;
  /** True when the block hit its cap (the harness cuts at the cap, so tokens never exceed it). */
  capped: boolean;
  count: number;
  ids: string[];
};

export type ReceiptView = {
  segments: BarSegment[];
  total: number;
  capsTotal: number;
  /** "12k of 18k in caps" or "12k tokens" (no caps in full mode). */
  totalText: string;
  mode: "full" | "window";
  /** One line: "Window mode, last 5 exchanges, 11 messages" / "Full history, 7 messages". */
  modeText: string;
  /** "3 tool results were replaced by stubs", or null. */
  clearedText: string | null;
};

function segment(b: ReceiptBlock, total: number): BarSegment {
  const tokens = Math.max(0, b.tokens);
  return {
    name: b.name,
    label: blockLabel(b.name),
    tokens,
    share: total > 0 ? tokens / total : 0,
    cap: b.cap,
    fill: b.cap > 0 ? Math.min(1, tokens / b.cap) : null,
    capped: b.cap > 0 && tokens >= b.cap,
    count: b.count,
    ids: b.ids,
  };
}

/** The receipt as the Context tab draws it: blocks in the order the harness sent them, with shares and cap fill. */
export function receiptView(r: ContextReceipt): ReceiptView {
  const total = r.blocks.reduce((n, b) => n + Math.max(0, b.tokens), 0);
  const segments = r.blocks.map((b) => segment(b, total));
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return {
    segments,
    total,
    capsTotal: r.caps_total,
    totalText: r.caps_total > 0 ? `${formatTokens(total)} of ${formatTokens(r.caps_total)} (trimmed to fit)` : `${formatTokens(total)} tokens`,
    mode: r.mode,
    modeText:
      r.mode === "window"
        ? `Recent only: last ${plural(r.recent_exchanges, "request", "requests")}, ${plural(r.message_count, "message", "messages")}`
        : `Full history, ${plural(r.message_count, "message", "messages")}`,
    clearedText: r.cleared_calls > 0 ? `${plural(r.cleared_calls, "tool result was", "tool results were")} shortened` : null,
  };
}

const NOUN: Record<string, [string, string]> = {
  memory_index: ["memory file", "memory files"],
  open_tasks: ["open task", "open tasks"],
  recent_window: ["recent request", "recent requests"],
  facts: ["fact", "facts"],
  current_turn: ["message", "messages"],
  history: ["message", "messages"],
  changed_tasks: ["changed task", "changed tasks"],
};

/** "3 open tasks", "1 memory file"; an unknown block (a newer harness) counts "items". */
export function countText(name: string, count: number): string {
  const [one, many] = NOUN[name] ?? ["item", "items"];
  return `${count} ${count === 1 ? one : many}`;
}
