import type { Limit, LimitKind, UsageBucket, UsageReport } from "@octo/agent-client";
import { formatDuration, formatTokens, timeAgo } from "./format";

const DAY = 86_400_000;

/** One day of a usage report (UTC days, as the harness buckets them). */
export type DayUsage = {
  key: string;
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  cost: number | null;
  estimated: boolean;
};

/** Every token a bucket counts: in + out + cache read + cache write. */
export function bucketTokens(b: Pick<UsageBucket, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">): number {
  return b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens;
}

/** The last `days` UTC days ending today, oldest first; a day without usage is a zero day (the report omits it). */
export function fillDays(report: UsageReport | null, days: number, now: number): DayUsage[] {
  const by = new Map((report?.buckets ?? []).map((b) => [b.key, b]));
  const today = Math.floor(now / DAY) * DAY;
  const out: DayUsage[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(today - i * DAY).toISOString().slice(0, 10);
    const b = by.get(key);
    out.push({
      key,
      total: b ? bucketTokens(b) : 0,
      input: b?.input_tokens ?? 0,
      output: b?.output_tokens ?? 0,
      cacheRead: b?.cache_read_tokens ?? 0,
      cacheWrite: b?.cache_write_tokens ?? 0,
      requests: b?.requests ?? 0,
      cost: b?.cost_usd ?? null,
      estimated: b?.cost_estimated ?? false,
    });
  }
  return out;
}

/** Above this max / median (of the days with data), a linear chart reads as broken: one bar, the rest flat. */
export const SQRT_ABOVE = 8;
/** Above this ratio even a square root leaves the other days at the floor: the scale becomes logarithmic. */
export const LOG_ABOVE = 100;

export type BarScale = "linear" | "sqrt" | "log";

/**
 * Integer bar heights in px for `values` in a chart `max` px tall. A day with data is at least `min` px; zero is 0.
 * When one value dominates the scale compresses — square root above `SQRT_ABOVE` × the median, logarithmic above
 * `LOG_ABOVE` × — so the other days stay readable; the caller says so in the chart's description.
 */
export function barHeights(values: readonly number[], max: number, min = 2): { scale: BarScale; heights: number[] } {
  const data = values.filter((v) => v > 0).sort((a, b) => a - b);
  const top = data[data.length - 1] ?? 0;
  if (top === 0) return { scale: "linear", heights: values.map(() => 0) };
  const median = data[Math.floor((data.length - 1) / 2)] ?? top;
  const ratio = top / median;
  const scale: BarScale = ratio > LOG_ABOVE ? "log" : ratio > SQRT_ABOVE ? "sqrt" : "linear";
  // log: measured from a tenth of the smallest day, so the smallest day keeps a visible bar above the floor.
  const base = (data[0] ?? 1) / 10;
  const f = scale === "sqrt" ? Math.sqrt : scale === "log" ? (v: number) => Math.log(v / base) : (v: number) => v;
  const peak = f(top);
  return { scale, heights: values.map((v) => (v > 0 ? Math.max(min, Math.round((f(v) / peak) * max)) : 0)) };
}

export function daysWithData(days: readonly DayUsage[]): number {
  return days.filter((d) => d.total > 0).length;
}

/** Compact USD: "<$0.01", "$0.42", "$12.30", "$123", "$1.2k". */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${Math.round(n)}`;
  if (n < 999_500) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

/** A bucket's cost as shown: "no price" when the harness has none for it (never "$0"), else compact USD. */
export function costText(b: Pick<UsageBucket, "cost_usd">): string {
  if (b.cost_usd !== null && isFlatRate(b)) return `≈ ${formatUsd(b.cost_usd)} on your subscription`;
  return b.cost_usd === null ? "no price" : formatUsd(b.cost_usd);
}

/**
 * A usage row the harness marks `flat_rate` (an agent on a subscription): its cost is what the tokens would have cost,
 * not money spent. Read defensively — older harnesses do not send the field.
 */
export function isFlatRate(b: object): boolean {
  return "flat_rate" in b && b.flat_rate === true;
}

/** What was paid: the total minus flat-rate rows (never added to the paid total); null when nothing has a price. */
export function paidCost(total: Pick<UsageBucket, "cost_usd">, buckets: readonly Pick<UsageBucket, "cost_usd">[]): number | null {
  if (total.cost_usd === null) return null;
  const flat = buckets.filter(isFlatRate).reduce((n, b) => n + (b.cost_usd ?? 0), 0);
  return Math.max(0, total.cost_usd - flat);
}

export type ShareRow = { key: string; label: string; tokens: number; share: number; bucket: UsageBucket };

/** Breakdown rows, largest first, with each one's share of the largest (for proportional bars) and of the total. */
export function shareRows(buckets: readonly UsageBucket[], value: (b: UsageBucket) => number = bucketTokens): ShareRow[] {
  const rows = buckets.map((b) => ({ key: b.key, label: b.label || b.key, tokens: value(b), share: 0, bucket: b }));
  rows.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
  const top = rows[0]?.tokens ?? 0;
  for (const r of rows) r.share = top > 0 ? r.tokens / top : 0;
  return rows;
}

/** Buckets grouped by an arbitrary label (agent ids → role), summing every field; cost stays null only if all parts are null. */
export function mergeBy(buckets: readonly UsageBucket[], label: (b: UsageBucket) => string): UsageBucket[] {
  const by = new Map<string, UsageBucket>();
  for (const b of buckets) {
    const name = label(b);
    const m = by.get(name);
    if (!m) {
      by.set(name, { ...b, key: name, label: name });
      continue;
    }
    m.input_tokens += b.input_tokens;
    m.output_tokens += b.output_tokens;
    m.cache_read_tokens += b.cache_read_tokens;
    m.cache_write_tokens += b.cache_write_tokens;
    m.requests += b.requests;
    m.cost_usd = m.cost_usd === null && b.cost_usd === null ? null : (m.cost_usd ?? 0) + (b.cost_usd ?? 0);
    m.cost_estimated ||= b.cost_estimated;
  }
  return [...by.values()];
}

/** "42s", "3m 10s", "1h 02m"; never negative. */
export function formatCountdown(ms: number): string {
  return formatDuration(Math.max(0, ms));
}

/** "resets in 42s" (stops at 0s); null when the provider sent no reset time. */
export function resetLabel(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return null;
  return `resets in ${formatCountdown(t - now)}`;
}

/** Limits older than this are shown dimmed as stale (the harness keeps the last headers it saw). */
export const LIMIT_STALE_MS = 10 * 60_000;

export function isStale(observedAt: string, now: number): boolean {
  return now - Date.parse(observedAt) > LIMIT_STALE_MS;
}

export function observedLabel(observedAt: string, now: number): string {
  return `observed ${timeAgo(observedAt, now)}`;
}

const KIND: Record<LimitKind, string> = { requests: "Requests", tokens: "Tokens", input_tokens: "Input tokens", output_tokens: "Output tokens" };
export function limitKindLabel(kind: LimitKind): string {
  return KIND[kind];
}

/** Remaining as a fraction of the limit (0–1), or null when either is unknown. */
export function remainingShare(l: Pick<Limit, "limit" | "remaining">): number | null {
  if (l.limit === null || l.remaining === null || l.limit <= 0) return null;
  return Math.min(1, Math.max(0, l.remaining / l.limit));
}

/** "38k of 40k left" style figure for a limit; requests as plain numbers. */
export function remainingText(l: Pick<Limit, "kind" | "limit" | "remaining">): string {
  if (l.remaining === null) return "unknown";
  const f = (n: number) => (l.kind === "requests" ? n.toLocaleString() : formatTokens(n));
  return l.limit === null ? `${f(l.remaining)} left` : `${f(l.remaining)} / ${f(l.limit)}`;
}

const KIND_ORDER: LimitKind[] = ["requests", "tokens", "input_tokens", "output_tokens"];
/** One row per provider + model + kind, grouped by provider then model, kinds in a fixed order. */
export function sortLimits(limits: readonly Limit[]): Limit[] {
  return [...limits].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}

/** A report's range for the last `days` UTC days: `from` today − (days − 1), `to` tomorrow (exclusive). */
export function rangeOf(days: number, now: number): { from: string; to: string } {
  const today = Math.floor(now / DAY) * DAY;
  return { from: new Date(today - (days - 1) * DAY).toISOString().slice(0, 10), to: new Date(today + DAY).toISOString().slice(0, 10) };
}
