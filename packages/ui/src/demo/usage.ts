import type { Agent, Limit, UsageBucket, UsageParams, UsageReport } from "@octo/agent-client";
import type { ProjectRecord } from "./store";

const DAY = 86_400_000;

/** Demo price table (USD per million tokens), like `prices.toml`: Haiku is missing on purpose, so "no price" shows. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
/** The demo ACP agent reports its own cost (`usage_update.cost`), about this much per thousand tokens. */
const ACP_USD_PER_K = 0.004;

function bucket(key: string, label: string): UsageBucket {
  return { key, label, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, requests: 0, cost_usd: null, cost_estimated: false };
}

/** One agent's usage as the harness would have recorded it: API agents read most of their prompt from the cache. */
function agentUsage(rec: ProjectRecord, a: Agent): Omit<UsageBucket, "key" | "label"> {
  const acp = a.model.startsWith("acp:");
  const calls = Math.max(1, rec.messages.filter((m) => m.agent_id === a.id && m.role === "assistant").length);
  const cacheRead = acp ? 0 : Math.round(a.input_tokens * 0.62);
  const cacheWrite = acp ? 0 : Math.round(a.input_tokens * 0.07);
  const price = PRICES[a.model];
  const cost = acp
    ? ((a.input_tokens + a.output_tokens) / 1000) * ACP_USD_PER_K
    : price
      ? (a.input_tokens * price.input + a.output_tokens * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1e6
      : null;
  return {
    input_tokens: a.input_tokens,
    output_tokens: a.output_tokens,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    requests: calls,
    cost_usd: cost,
    cost_estimated: !acp && price !== undefined,
  };
}

function add(into: UsageBucket, u: Omit<UsageBucket, "key" | "label">) {
  into.input_tokens += u.input_tokens;
  into.output_tokens += u.output_tokens;
  into.cache_read_tokens += u.cache_read_tokens;
  into.cache_write_tokens += u.cache_write_tokens;
  into.requests += u.requests;
  if (u.cost_usd !== null) into.cost_usd = (into.cost_usd ?? 0) + u.cost_usd;
  into.cost_estimated ||= u.cost_estimated;
}

function scaled(u: Omit<UsageBucket, "key" | "label">, f: number): Omit<UsageBucket, "key" | "label"> {
  return {
    ...u,
    input_tokens: u.input_tokens * f,
    output_tokens: u.output_tokens * f,
    cache_read_tokens: u.cache_read_tokens * f,
    cache_write_tokens: u.cache_write_tokens * f,
    requests: 1,
    cost_usd: u.cost_usd === null ? null : u.cost_usd * f,
  };
}

function round(b: UsageBucket) {
  b.input_tokens = Math.round(b.input_tokens);
  b.output_tokens = Math.round(b.output_tokens);
  b.cache_read_tokens = Math.round(b.cache_read_tokens);
  b.cache_write_tokens = Math.round(b.cache_write_tokens);
}

function parseDate(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(t) ? fallback : t;
}

/**
 * `GET /v1/usage` over the demo records (an agent's usage counts on the UTC day it started), grouped by day, model,
 * project or agent like the harness, with cache tokens and costs from the demo price table (estimated) or reported
 * by the ACP agent.
 */
export function demoUsage(records: Iterable<ProjectRecord>, params: UsageParams | undefined, now: number): UsageReport {
  const to = parseDate(params?.to, Math.floor(now / DAY) * DAY + DAY);
  const from = parseDate(params?.from, to - 30 * DAY);
  const group = params?.group ?? "day";
  const total = bucket("total", "Total");
  const buckets = new Map<string, UsageBucket>();
  for (const rec of records) {
    if (params?.project && rec.project.id !== params.project) continue;
    for (const a of rec.agents) {
      if (a.input_tokens + a.output_tokens === 0) continue;
      // The harness writes one row per model response: the agent's totals are spread evenly over its replies.
      const replies = rec.messages.filter((m) => m.agent_id === a.id && m.role === "assistant").map((m) => Date.parse(m.created_at));
      const times = replies.length ? replies : [Date.parse(a.started_at ?? a.created_at)];
      const u = agentUsage(rec, a);
      const share = scaled(u, 1 / times.length);
      for (const at of times) {
        if (at < from || at >= to) continue;
        const key = group === "model" ? a.model : group === "project" ? rec.project.id : group === "agent" ? a.id : new Date(at).toISOString().slice(0, 10);
        const label = group === "project" ? rec.project.name : group === "agent" ? (a.parent_id === null ? "Orchestrator" : a.role) : key;
        const b = buckets.get(key) ?? bucket(key, label);
        buckets.set(key, b);
        add(b, share);
        add(total, share);
      }
    }
  }
  for (const b of [...buckets.values(), total]) round(b);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), group, buckets: [...buckets.values()], total };
}

/** `GET /v1/limits`: the latest rate-limit headers per model and kind, one model's rows stale (seen 14 minutes ago). */
export function demoLimits(now: number): Limit[] {
  const window = 60_000;
  const reset = new Date(Math.ceil(now / window) * window).toISOString();
  const seen = new Date(now - 40_000).toISOString();
  const provider = "api.anthropic.com";
  const opus = "claude-opus-5-5";
  const rows: Limit[] = [
    { provider, model: opus, kind: "requests", limit: 4000, remaining: 3874, resets_at: reset, observed_at: seen },
    { provider, model: opus, kind: "input_tokens", limit: 2_000_000, remaining: 1_712_400, resets_at: reset, observed_at: seen },
    { provider, model: opus, kind: "output_tokens", limit: 400_000, remaining: 31_200, resets_at: reset, observed_at: seen },
    {
      provider,
      model: "claude-sonnet-5-5",
      kind: "tokens",
      limit: 4_000_000,
      remaining: 3_960_000,
      resets_at: new Date(now + 4 * 60_000 + 12_000).toISOString(),
      observed_at: new Date(now - 3 * 60_000).toISOString(),
    },
    {
      provider,
      model: "claude-haiku-5-5",
      kind: "requests",
      limit: 4000,
      remaining: 3998,
      resets_at: new Date(now - 13 * 60_000).toISOString(),
      observed_at: new Date(now - 14 * 60_000).toISOString(),
    },
  ];
  return rows;
}
