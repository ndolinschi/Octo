import type { Limit } from "@octo/agent-client";

const HOSTS: Record<string, string> = { "api.anthropic.com": "Anthropic API", "openrouter.ai": "OpenRouter" };

/** C20: a plan limit's title in words a person reads: "Anthropic API · requests" (a host we do not know stays as it is). */
export function limitTitle(l: Pick<Limit, "provider" | "kind">): string {
  return `${HOSTS[l.provider] ?? l.provider} · ${l.kind.replace(/_/g, " ")}`;
}

/** C20: when a limit resets, relative ("resets in 12 min"); the absolute time goes in the tooltip. */
export function resetsIn(iso: string | null | undefined, now: number): string {
  if (!iso) return "No reset time reported";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "No reset time reported";
  if (ms <= 30_000) return "Resets any moment";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `Resets in ${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `Resets in ${h} h`;
  return `Resets in ${Math.round(h / 24)} days`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * B11: a budget row's one sentence about spend: the larger of the project's own figure (`spent_usd`) and the all-time cost the
 * usage table shows, so the two never disagree; the budget is a total, not per month (apps/harness/docs/architecture.md, Budget).
 */
export function spendText(spent: number | null | undefined, usage: number | null | undefined, budget: string): string {
  // The harness's own figure is the larger of the router's report and the usage rows; the table's all-time cost is those rows.
  const known = [spent, usage].filter((n): n is number => typeof n === "number");
  const used = known.length ? Math.max(...known) : undefined;
  if (used === undefined && usage === null) return `Spend not known: a model it used has no price.${budget ? ` Budget $${budget} in total.` : " No budget."}`;
  if (used === undefined) return budget ? `Nothing spent yet. Budget $${budget} in total.` : "Nothing spent yet. No budget.";
  return budget ? `${usd(used)} of $${budget} used, in total.` : `${usd(used)} spent so far. No budget.`;
}
