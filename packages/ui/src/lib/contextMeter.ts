import type { ContextBreakdown, ContextPartKey } from "@octo/agent-client";
import { formatTokens } from "./format";

const LABEL: Record<ContextPartKey, string> = {
  system: "System prompt",
  tools: "Tool definitions",
  notes: "Notes",
  messages: "Messages",
  tool_results: "Tool results",
  summary: "Compacted summary",
};

/** Order of the bar's segments and the legend: what the user controls (messages, results) first. */
const ORDER: readonly ContextPartKey[] = ["messages", "tool_results", "summary", "notes", "tools", "system"];

/** Parts smaller than this share of the used tokens fold into "Other" (decision 38). */
export const OTHER_BELOW = 0.005;

export type ContextRow = { key: ContextPartKey | "other"; label: string; tokens: number; share: number };

export type ContextMeter = {
  /** "12% used"; null when the window is unknown. */
  percent: string | null;
  /** "118k / 1M" or "118k tokens". */
  amount: string;
  /** Share of the window in use, 0–1 (0 when unknown). */
  fill: number;
  rows: ContextRow[];
  estimated: boolean;
};

/** Decision 38's Context section from `GET …/context`: the percentage, the amount, and the parts in a fixed order. */
export function contextMeter(b: ContextBreakdown): ContextMeter {
  const used = Math.max(0, b.used_tokens);
  const window = b.window_tokens && b.window_tokens > 0 ? b.window_tokens : null;
  const fill = window ? Math.min(1, used / window) : 0;
  const rows: ContextRow[] = [];
  let other = 0;
  for (const key of ORDER) {
    const tokens = b.parts.filter((p) => p.key === key).reduce((n, p) => n + Math.max(0, p.tokens), 0);
    if (tokens <= 0) continue;
    const share = used > 0 ? tokens / used : 0;
    if (share < OTHER_BELOW) other += tokens;
    else rows.push({ key, label: LABEL[key], tokens, share });
  }
  if (other > 0) rows.push({ key: "other", label: "Other", tokens: other, share: used > 0 ? other / used : 0 });
  const pct = window ? Math.round(fill * 100) : null;
  return {
    percent: pct === null ? null : `${pct === 0 && used > 0 ? "<1" : pct}% used`,
    amount: window ? `${formatTokens(used)} / ${formatTokens(window)}` : `${formatTokens(used)} tokens`,
    fill,
    rows,
    estimated: b.estimated,
  };
}

/** A share as the legend shows it: "42%", "<1%". */
export function shareText(share: number): string {
  const pct = Math.round(share * 100);
  return pct === 0 && share > 0 ? "<1%" : `${pct}%`;
}
