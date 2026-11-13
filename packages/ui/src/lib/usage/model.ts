import type { UsageBucket } from "@octo/agent-client";
import { formatUsd, isFlatRate, mergeBy, rangeOf, subscriptionEquivalent } from "../usage";
import type { UsagePeriod } from "../usageView";

/* Decision 86: the view-model of the usage table (By model / By agent / By day / by project). Pure; the table renders it. */

export const USAGE_PERIODS: readonly { id: UsagePeriod; label: string }[] = [
  { id: "session", label: "This session" },
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All" },
];

/** `from` / `to` for `GET /v1/usage`; `to` is left to the harness (tomorrow, UTC). "This session" is since the window opened. */
export function periodRange(period: UsagePeriod, now: number, sessionStart: number): { from: string; to?: string } {
  switch (period) {
    case "session":
      return { from: new Date(sessionStart).toISOString() };
    case "today":
      return rangeOf(1, now);
    case "7d":
      return rangeOf(7, now);
    case "30d":
      return rangeOf(30, now);
    case "all":
      return { from: "2000-01-01" };
  }
}

/** How many days the daily chart draws: the period's own length; for "All" from the first day with usage, at most 90. */
export function chartDays(period: UsagePeriod, firstDay: string | null, now: number): number {
  const DAY = 86_400_000;
  switch (period) {
    case "session":
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all": {
      const first = firstDay ? Date.parse(`${firstDay}T00:00:00Z`) : NaN;
      if (Number.isNaN(first)) return 7;
      return Math.min(90, Math.max(7, Math.floor((now - first) / DAY) + 1));
    }
  }
}

export function periodText(period: UsagePeriod): string {
  return USAGE_PERIODS.find((p) => p.id === period)?.label ?? "All";
}

/** Spent money (null: an API row without a price) and what subscription rows would have cost (never added to spend). */
export type RowCost = { spent: number | null; equivalent: number; estimated: boolean };

export type UsageRow = {
  key: string;
  label: string;
  input: number;
  /** Cache reads + cache writes: input served from or stored in the provider's cache. */
  cached: number;
  output: number;
  total: number;
  requests: number;
  cost: RowCost;
  /** Fraction of the table's total tokens. */
  share: number;
  /** Some token counts are the harness's estimate (an ACP agent reported none). */
  tokensEstimated: boolean;
};

export type UsageTotals = Omit<UsageRow, "key" | "label" | "share" | "cost"> & { cost: RowCost; unpriced: boolean };

/** Spent and subscription equivalent of one bucket, following the usage contract (`flat_rate`, `subscription_equivalent_usd`). */
export function rowCost(b: UsageBucket): RowCost {
  const equivalent = subscriptionEquivalent(b) ?? 0;
  const explicit = typeof b.subscription_equivalent_usd === "number";
  // An older harness put a subscription's equivalent into cost_usd: that is no spend.
  const spent = b.flat_rate === true && !explicit ? 0 : b.cost_usd;
  return { spent, equivalent, estimated: b.cost_estimated && !isFlatRate(b) };
}

/** The cost cell: "$1.20", "≈ $0.50 on your subscription", "$1.20 + ≈ $0.50 subscription", "no price". */
export function costCellText(c: RowCost): string {
  if (c.spent === null) return c.equivalent > 0 ? `no price + ≈ ${formatUsd(c.equivalent)} subscription` : "no price";
  if (c.equivalent > 0)
    return c.spent > 0 ? `${formatUsd(c.spent)} + ≈ ${formatUsd(c.equivalent)} subscription` : `≈ ${formatUsd(c.equivalent)} on your subscription`;
  return formatUsd(c.spent);
}

function tokensEstimated(b: object): boolean {
  return "tokens_estimated" in b && b.tokens_estimated === true;
}

function toRow(b: UsageBucket, label: string): Omit<UsageRow, "share"> {
  const cached = b.cache_read_tokens + b.cache_write_tokens;
  return {
    key: b.key,
    label,
    input: b.input_tokens,
    cached,
    output: b.output_tokens,
    total: b.input_tokens + cached + b.output_tokens,
    requests: b.requests,
    cost: rowCost(b),
    tokensEstimated: tokensEstimated(b),
  };
}

export type RowOrder = "total" | "key-desc";

/** Rows for a report's buckets: sorted (largest first, or newest key first for days) with each row's share of the total. */
export function usageRows(buckets: readonly UsageBucket[], label: (b: UsageBucket) => string = (b) => b.label || b.key, order: RowOrder = "total"): UsageRow[] {
  const rows = buckets.map((b) => toRow(b, label(b)));
  const sum = rows.reduce((n, r) => n + r.total, 0);
  rows.sort(order === "total" ? (a, b) => b.total - a.total || a.label.localeCompare(b.label) : (a, b) => b.key.localeCompare(a.key));
  return rows.map((r) => ({ ...r, share: sum > 0 ? r.total / sum : 0 }));
}

/** The totals row: the sum of the rows shown (so it always equals them); spent counts the priced rows only. */
export function usageTotals(rows: readonly UsageRow[]): UsageTotals {
  const t: UsageTotals = {
    input: 0,
    cached: 0,
    output: 0,
    total: 0,
    requests: 0,
    tokensEstimated: false,
    unpriced: false,
    cost: { spent: null, equivalent: 0, estimated: false },
  };
  for (const r of rows) {
    t.input += r.input;
    t.cached += r.cached;
    t.output += r.output;
    t.total += r.total;
    t.requests += r.requests;
    t.tokensEstimated ||= r.tokensEstimated;
    t.cost.equivalent += r.cost.equivalent;
    t.cost.estimated ||= r.cost.estimated;
    if (r.cost.spent === null) t.unpriced = true;
    else t.cost.spent = (t.cost.spent ?? 0) + r.cost.spent;
  }
  return t;
}

export type RoleRow = UsageRow;
export type ModelRowWithRoles = UsageRow & { roles: RoleRow[] };

/**
 * "Show roles": the agent report's buckets (one per agent, labelled by role) placed under the model that ran them.
 * `modelOf` resolves an agent id to the model id the model report keys by; roles of the same name under one model merge.
 * Buckets whose agent or model is not known are returned apart (the harness has no model × role report).
 */
export function placeRoles(
  models: readonly UsageRow[],
  agents: readonly UsageBucket[],
  modelOf: (agentKey: string) => string | null,
  roleName: (b: UsageBucket) => string,
): { rows: ModelRowWithRoles[]; unplaced: UsageRow[] } {
  const known = new Set(models.map((m) => m.key));
  const by = new Map<string, UsageBucket[]>();
  const loose: UsageBucket[] = [];
  for (const b of agents) {
    const m = modelOf(b.key);
    if (m === null || !known.has(m)) loose.push(b);
    else by.set(m, [...(by.get(m) ?? []), b]);
  }
  // B44: a role's bar is its share of the whole table, as a model's is, so every bar in the column compares with every other.
  const table = models.reduce((n, m) => n + m.total, 0);
  const rows = models.map((m) => ({
    ...m,
    roles: usageRows(mergeBy(by.get(m.key) ?? [], roleName)).map((r) => ({ ...r, share: table > 0 ? r.total / table : 0 })),
  }));
  return { rows, unplaced: usageRows(mergeBy(loose, roleName)) };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of the visible table (decision 86 e): exact numbers, spend and subscription equivalent in their own columns. */
export function usageCsv(first: string, rows: readonly { row: UsageRow; parent?: string }[], totals: UsageTotals): string {
  const head = [first, "Input", "Cached", "Output", "Total tokens", "Requests", "Cost (USD)", "On subscription (USD)"];
  const line = (label: string, r: Omit<UsageRow, "key" | "label" | "share">) =>
    [
      label,
      r.input,
      r.cached,
      r.output,
      r.total,
      r.requests,
      r.cost.spent === null ? "" : r.cost.spent.toFixed(4),
      r.cost.equivalent > 0 ? r.cost.equivalent.toFixed(4) : "",
    ]
      .map(csvCell)
      .join(",");
  return [
    head.map(csvCell).join(","),
    ...rows.map(({ row, parent }) => line(parent ? `${parent} / ${row.label}` : row.label, row)),
    line("Total", totals),
  ].join("\n");
}
