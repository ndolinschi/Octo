import type { ContextBreakdown, ContextOverview, ContextPartKey } from "@octo/agent-client";
import { formatTokens } from "./format";

const LABEL: Record<ContextPartKey, string> = {
  // One name per category, the same as the context popover's (lib/contextView.ts).
  system: "Instructions",
  tools: "Tool definitions",
  notes: "Notes and memory",
  messages: "Messages",
  tool_results: "Tool results",
  summary: "Compacted summary",
};

/** Maps `ContextOverview` category ids onto the six bar parts (decision 38). */
const CATEGORY_PART: Record<string, ContextPartKey> = {
  system: "system",
  instructions: "system",
  files: "system",
  tools: "tools",
  mcp_tools: "tools",
  agents: "tools",
  notes: "notes",
  memory: "notes",
  messages: "messages",
  current_request: "messages",
  tool_results: "tool_results",
  summary: "summary",
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

const isBreakdown = (v: ContextBreakdown | ContextOverview): v is ContextBreakdown => "parts" in v && Array.isArray(v.parts);

/** Decision 38's Context section from `GET …/context`: the percentage, the amount, and the parts in a fixed order. */
export function contextMeter(b: ContextBreakdown | ContextOverview): ContextMeter {
  const breakdown = isBreakdown(b);
  const used = Math.max(0, breakdown ? b.used_tokens : b.used);
  const rawWindow = breakdown ? (b.window_tokens ?? b.window) : b.window;
  const window = rawWindow && rawWindow > 0 ? rawWindow : null;
  const fill = window ? Math.min(1, used / window) : 0;
  const byPart = new Map<ContextPartKey, number>();
  let other = 0;

  if (breakdown) {
    for (const p of b.parts) {
      const tokens = Math.max(0, p.tokens);
      if (tokens <= 0) continue;
      byPart.set(p.key, (byPart.get(p.key) ?? 0) + tokens);
    }
  } else {
    for (const c of b.categories) {
      const tokens = Math.max(0, c.tokens);
      if (tokens <= 0) continue;
      const part = CATEGORY_PART[c.id];
      if (part) byPart.set(part, (byPart.get(part) ?? 0) + tokens);
      else other += tokens;
    }
  }

  const rows: ContextRow[] = [];
  for (const key of ORDER) {
    const tokens = byPart.get(key) ?? 0;
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
    estimated: b.estimated ?? true,
  };
}

/** A share as the legend shows it: "42%", "<1%". */
export function shareText(share: number): string {
  const pct = Math.round(share * 100);
  return pct === 0 && share > 0 ? "<1%" : `${pct}%`;
}
