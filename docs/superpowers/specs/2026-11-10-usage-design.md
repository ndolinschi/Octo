# Usage: tokens, cost and limits — design draft

**Date:** 2026-11-10 · **Status:** Phase A approved by the owner (2026-11-10); subscriptions: option B1. Research by a sub-agent, not re-verified by the orchestrator
**Builds on:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md), [`2026-11-10-workspace-plugins-acp-design.md`](./2026-11-10-workspace-plugins-acp-design.md)

Owner request: a Usage panel (Cost / Tokens / Limits) for API providers and for ACP agents that run on a
subscription. The rule: show only what a source reports through a documented channel; label estimates.

## What each source can give

| Data | Direct API (Anthropic, OpenAI-compatible) | OpenRouter | ACP agents |
| --- | --- | --- | --- |
| Tokens per request | `usage` on every response (already stored per agent) | `usage` on every response | Not in the standard per turn. `usage_update` gives context occupancy only (`used`, `size`) |
| Cost | Computed: tokens × a price table the harness owns (estimate) | `usage.cost` per response; totals from `GET /api/v1/key` | `usage_update.cost` (`amount`, `currency`, cumulative) when the agent sends it |
| Rate limit remaining / reset | Response headers: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` (reset RFC 3339); `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` (reset as a duration, may be absent) | No rate headers; credit cap from `/api/v1/key` (`limit_remaining`, `limit_reset`) | Not available: the headers stay inside the agent's own process |
| Subscription limit remaining / reset (session, weekly) | n/a | n/a | **No documented programmatic source.** Claude Code exposes `rate_limits.five_hour` / `seven_day` only to its interactive status line; Codex `/status` and Gemini `/stats` are human-facing. Trackers that show these read the CLI's stored credentials or undocumented endpoints |

Sources are listed in the research report (ACP `session-usage` RFD, provider rate-limit docs, OpenRouter key API,
Claude Code status line and legal pages). Not verified: whether the Claude Code, Codex and Gemini ACP adapters
actually emit `usage_update`; OpenAI's usage/cost endpoints; the unit of OpenRouter's `cost`.

## Proposed scope

**Phase A — reliable, no policy questions**

1. Harness: per-request usage rows (`usage` table: agent, model, provider, in/out/cache tokens, time) instead of
   only per-agent totals; `GET /v1/usage?from=&to=&group=day|model|project`.
2. Harness: optional price table in the harness's own config (`prices.toml` in the data dir; never the router's
   file) → cost as an estimate, absent when a model has no price.
3. Harness: remember the latest rate-limit headers per provider + model class → `GET /v1/limits`
   (`{ provider, scope, limit, remaining, resets_at, observed_at }`); OpenRouter key info polled at most once a minute.
4. ACP: map `usage_update` → context `used` / `size` per agent and `cost` when present (today only token counts
   are read, approximately).
5. UI: a Usage tab — Tokens (by day, model, project), Cost (estimate, per model), Limits (one row per provider
   scope: bar, remaining, reset time, "observed 2m ago"); Home's Tokens card reads the same endpoint.

**Phase B — needs the owner's decision**

Subscription limits for ACP agents (Claude Pro/Max, ChatGPT Plus/Pro, Google AI plans). Options:

| Option | How | Risk |
| --- | --- | --- |
| B1. Do not show | — | None; the panel says "reported by the agent's own CLI" with the command to run |
| B2. Opt-in helper per agent | The user configures the agent's own documented hook (e.g. a Claude Code status-line script) to write its limits to a file the harness reads | Only works when the user also runs that CLI interactively; ACP sessions may not run the hook (unverified) |
| B3. Read the CLI's stored credentials / undocumented endpoints | What menu-bar trackers do | Anthropic's Claude Code legal page forbids third-party tools from collecting or intermediating Claude.ai credentials or session tokens; undocumented endpoints break without notice |

Recommendation: A now-ish (its own pass, after v6), B1 by default, B2 as a later experiment, not B3.

## Phase A contract (harness + client)

The harness speaks the Anthropic Messages API to its `--base-url` (Anthropic, the Octo router, or a compatible
gateway) and ACP to plugin agents, so "provider" here is the base URL's host, and limits are read from whatever
headers that host returns (`anthropic-ratelimit-*`, else `x-ratelimit-*`).

**Storage** (per-project SQLite, migration adds):

```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL, -- "api" | "acp"
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,            -- reported by the source (ACP usage_update.cost in USD) or NULL
  created_at TEXT NOT NULL  -- RFC 3339 UTC
);
CREATE INDEX usage_created ON usage(created_at);
```

One row per model response (API) or per ACP usage delta. Agent totals (`agents.input_tokens/output_tokens`) keep
working as today. Existing projects have no rows before the migration — totals for them start empty (documented).

**Prices** (optional): `{data-dir}/prices.toml`, the harness's own file —

```toml
[models."claude-opus-5-5"]
input = 5.0        # USD per 1M tokens
output = 25.0
cache_read = 0.5   # optional
cache_write = 6.25 # optional
```

Missing file or model → cost is `null` (never 0). Malformed file → logged, treated as missing. Read at startup.

**API**

| Method | Path | Response |
| --- | --- | --- |
| GET | `/v1/usage?from=&to=&group=day\|model\|project\|agent&project=` | `UsageReport` |
| GET | `/v1/limits` | `{ "limits": Limit[] }` |

```ts
type UsageBucket = {
  key: string;                 // "2026-11-10" | model id | project id | agent id
  label: string;               // same as key for day/model; project name; agent role
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  requests: number;
  cost_usd: number | null;     // reported cost + estimated cost; null when nothing in the bucket has a price
  cost_estimated: boolean;     // true when any part comes from the price table
};
type UsageReport = { from: string; to: string; group: string; buckets: UsageBucket[]; total: UsageBucket };
type Limit = {
  provider: string;            // base URL host, e.g. "api.anthropic.com"
  model: string;               // model of the response the headers came with
  kind: "requests" | "tokens" | "input_tokens" | "output_tokens";
  limit: number | null; remaining: number | null;
  resets_at: string | null;    // RFC 3339; durations ("6m0s") are converted using the observation time
  observed_at: string;
};
```

`from` / `to` are RFC 3339 or `YYYY-MM-DD` (UTC days, `to` exclusive; default the last 30 days); `group`
defaults to `day` (days with no usage are omitted); `project` narrows to one project. Bad parameters → 400 in
the existing error shape. Limits are held in memory (latest per provider + model + kind), empty after a restart.

**ACP**: `usage_update` → agent context fields `context_used`, `context_size` on `Agent` (nullable numbers,
persisted) and, when `cost` is present with currency `USD`, a usage row whose `cost_usd` is the increase since the
previous update. Token deltas keep being recorded as today (approximate) with `source: "acp"`.

**Client** (`@octo/agent-client`): types above; `Bridge.getUsage(params?)`, `Bridge.getLimits()`; both on the
message-bridge allow-list; `Agent` gains `context_used`, `context_size`. The UI's demo bridge gets stub
implementations (empty report, no limits) so the type-check passes; the Usage tab itself is a later UI pass.

**Subscriptions (B1)**: not read. The UI will say that plan limits are shown by the agent's own CLI.

### Acceptance criteria (Phase A)

1. Every model response and ACP usage delta writes a usage row; agent totals are unchanged; the migration runs on
   an existing project database without data loss (test with a pre-migration fixture).
2. `/v1/usage` groups by day, model, project and agent, across projects and for one; totals equal the sum of
   buckets; empty ranges return empty buckets, not an error; bad parameters return 400.
3. With a price table, cost = tokens × prices, `cost_estimated: true`; without one, `cost_usd: null`. A model
   missing from the table does not zero the bucket's cost.
4. Rate-limit headers from a response (Anthropic style and `x-ratelimit-*` style, including a duration reset) are
   exposed by `/v1/limits`; absent headers yield no entries; a later response replaces the earlier values.
5. A scripted ACP agent that sends `usage_update` with `used`, `size` and a USD cost sets the agent's context
   fields and records the cost increase; a non-USD currency is ignored for cost.
6. The mock model can emit rate-limit headers (so the live stack shows limits without a real key).
7. Gates: `gofmt`, `go vet`, `go test -race ./...`, agent-client tests, UI type-check, desktop build.

## Open questions

- Capture real `session/update` traffic from the three ACP adapters to see what they emit.
- Where prices come from by default (ship none; document the file).
