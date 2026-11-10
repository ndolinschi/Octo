# Usage: tokens, cost and limits — design draft

**Date:** 2026-11-10 · **Status:** draft (research done by a sub-agent; not re-verified by the orchestrator; nothing built)
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

## Open questions

- Capture real `session/update` traffic from the three ACP adapters to see what they emit.
- Where prices come from by default (ship none; document the file).
