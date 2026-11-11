# Router ↔ harness integration: auto-routing that saves the harness money — design

**Date:** 2026-11-11 · **Status:** approved direction (owner: "all of this must integrate between the router and the
harness and work together; auto-routing must help the harness economise"); I1 to build now, I2–I3 after
**Builds on:** [`2026-11-10-usage-design.md`](./2026-11-10-usage-design.md),
[`2026-11-10-subscription-agents-design.md`](./2026-11-10-subscription-agents-design.md) (S3a),
[`../research/2026-11-10-cost-audit.md`](../research/2026-11-10-cost-audit.md), `apps/router/docs/autoroute.md`

## Where money goes today, and what each side knows

| | Harness knows | Router knows |
| --- | --- | --- |
| The task | role, depth, the tier the orchestrator asked for, which tools, the project | only the request body |
| The price | nothing unless a `prices.toml` is supplied | the price table, the ladder, the upstream's reported cost, cache hits |
| The limits | rate-limit headers it happened to see; subscription agents' login state | budgets per session / budget key |
| The decision | the orchestrator picks a tier by prompt | the classifier picks a ladder tier per turn |

They decide independently and account separately. The cost audit found the consequences: the harness prices by the
model it *requested*, not the one served; budgets are per agent session, so every sub-agent starts fresh; the
router's compaction is never applied by the harness; the orchestrator chooses tiers without any price signal; and
subscription agents (flat-rate) are never preferred over paid tokens.

## Principles

1. **One decision, made where the information is.** The harness says what the task is (hints); the router decides
   the model and says what it did (result headers). The harness never second-guesses a routed model.
2. **One ledger.** The router's cost figure is the cost; the harness records it per request and stops estimating
   when the router is in the path.
3. **One budget, keyed by project.** Sub-agents spend from the project's budget.
4. **Flat-rate first.** A logged-in subscription agent that suits the task costs nothing at the margin until its
   plan limit; paid tokens are the fallback.
5. **Works without the router.** Everything degrades to today's behaviour when `--base-url` is not an Octo router.

## I1 — one path, one ledger, one budget (build now)

**Detection.** At start-up the harness calls `GET {base-url-origin}/health`; a response with
`"service":"octo"` and `"capabilities":[...]` turns integration on (`router: true` in `GET /v1/config`). Capability
names: `autoroute`, `route_hints`, `result_headers`, `budget_key`, `route_api`.

**Request hints (harness → router, on every Messages request; stripped before upstream):**

| Header | Value |
| --- | --- |
| `x-octo-budget-key` | the project id |
| `x-octo-agent-role` | `orchestrator` \| `sub` |
| `x-octo-agent-depth` | `0`, `1`, … |
| `x-octo-tier-hint` | `fast` \| `balanced` \| `deep` — the tier the harness would have used |
| `x-octo-tier-policy` | `auto` (router may go lower or higher within its ladder) \| `ceiling` (never above the hint) \| `fixed` (use the hint's ladder tier) |
| `x-octo-task` | first 200 chars of the task title, URL-encoded (classifier context for sub-agents; optional) |

The router maps hints to its ladder (`fast→low`, `balanced→mid`, `deep→high`), uses them as the starting point for
a new session instead of the default, and still applies its sticky / stall / budget rules. A sub-agent session
starts at `min(hint, classifier)` under `auto`. Unknown headers are ignored by older routers.

**Result headers (router → harness, on every response incl. streamed ones, set before the body):**

| Header | Value |
| --- | --- |
| `x-octo-model` | the model actually served (ladder slug) |
| `x-octo-tier` | `low` \| `mid` \| `high` |
| `x-octo-trigger` | why (`classifier`, `sticky`, `hint`, `budget`, `stall`, `classifier_failure`, `compact`, …) |
| `x-octo-budget-usd`, `x-octo-spent-usd` | the budget and spend for the budget key, when a budget is set |
| `x-octo-request-id` | id of the router's history row |

Cost is known only after the stream ends, so it is **not** a header: the harness reads it from
`GET /autoroute/v1/calls/{request-id}` → `{ model, tier, trigger, input_tokens, output_tokens, cache_read_tokens,
cache_write_tokens, cost_usd, cost_source: "reported" | "estimated" }` (available once the response has finished;
404 until then; the harness fetches it once after the stream closes, with one retry after 200 ms).

**Ledger.** Usage rows gain `served_model`, `tier`, `route_trigger`, `router_request_id`; with the router in the
path `cost_usd` is the router's figure and `cost_estimated` follows `cost_source`. `/v1/usage` groups by the served
model. Failed and cancelled requests are recorded too (tokens as far as known, cost from the router).

**Budget.** `Project.budget_usd` (nullable; `PATCH /v1/projects/{pid}`): the harness sends it as
`x-octo-budget-usd` with the budget key (the router uses the smaller of its configured session budget and this);
the router's reject (402) settles the agent as failed with "Project budget reached ($X of $Y)" and stops the turn;
the harness also refuses to start new sub-agents once the last known spend ≥ budget. Without a router the harness
enforces the budget itself from its own usage rows when prices are known.

**Compaction.** When the router answers with a compaction result (`x-octo-trigger: compact` and the summary in the
body), the harness **applies it**: it stores the summary as the agent's compacted history (the raw messages stay in
the database for the UI) and sends the shortened history from the next request on. This closes the audit's loop
finding from the harness side and gives the orchestrator the compaction it lacks.

**Acceptance (I1).** (1) With a mock upstream behind a real router, a harness turn with three sub-agents shows one
budget key for all of them and per-request `served_model`, `tier`, `trigger` and router cost in `/v1/usage`.
(2) A budget of $0.01 stops the turn with the budget message; no further upstream calls happen. (3) `tier-policy:
ceiling` never serves above the hint; `fixed` serves the hint's tier. (4) A router compaction is applied: the next
request is shorter and the router does not compact again. (5) Against a non-Octo base URL nothing changes and no
`x-octo-*` request header is sent. (6) All gates in both apps.

## As built — I1, router side (2026-11-11)

Built in `apps/router` (20 new tests in `tests/harness_integration.rs`; 219 pass). Decisions taken while building:

- **A budget sent in `x-octo-budget-usd` always rejects (402)** when it is the effective one, whatever
  `session_budget_action` says; the configured budget keeps its configured action when it is the smaller.
- `x-octo-budget-usd` is ignored without `x-octo-budget-key`; the key needs no session id.
- `x-octo-spent-usd` is the spend **before** the response it is on.
- `x-octo-request-id` is `octo_<hex>` (the final attempt's id on a retry), not a history row id. Call records are
  kept in memory only (4096 rows); the SQLite history has no request id yet.
- A call with neither a reported cost nor a price entry reads `cost_usd: 0`, `cost_source: "estimated"`.
- A plain sticky turn reports trigger `none` (the history column's value); `hint` is new; a budget clamp reports
  `budget_cap`.
- Errors raised before any upstream response exists (e.g. a connect failure → 502) carry no `x-octo-*` headers.
- **Compaction for the client:** header `x-octo-trigger: compact`; the body is the upstream Messages JSON, never a
  stream. It succeeded only on 2xx with `stop_reason == "compaction"`; the summary is the `content[]` block of
  `type: "compaction"` (its `content` string), else the concatenated `text` blocks. If the next request is not
  shorter the router forwards normally with trigger `compact_not_applied`.
- Hints are also read on `/autoroute/v1/chat/completions`.

## I2 — a routing decision for delegation (after I1)

`POST /autoroute/v1/route` — the harness asks before it spawns a sub-agent whose tier the orchestrator left open
(`tier: "auto"`, the new default in the orchestrator's prompt and tool schema):

```ts
// request
{ budget_key: string; task: { title: string; brief: string; tools: string[]; depth: number };
  candidates: Candidate[] }
type Candidate =
  | { id: string; kind: "api"; tier: "fast" | "balanced" | "deep" }
  | { id: string; kind: "agent"; label: string; flat_rate: boolean; logged_in: boolean;
      limit_remaining?: number | null; strengths?: string[] };        // subscription / ACP agents from the plugins
// response
{ choice: string; model?: string; band: "easy" | "medium" | "hard"; reason: string;
  estimated_cost_usd: number | null; alternatives: { id: string; estimated_cost_usd: number | null }[] }
```

Policy in the router (configurable): classify the task once (the existing classifier, capped input); among
candidates able to do that band, prefer `flat_rate && logged_in` agents with remaining limit, then the cheapest API
tier by the price table; never choose an agent that is logged out. The harness records the decision and the reason
on the agent (`route_reason`), shows it in the Agent tab, and falls back to the orchestrator's own choice if the
router is unreachable (300 ms timeout).

## I3 — showing the savings (after I2)

Usage → Cost gains "Auto-routing": actual cost vs. what the same tokens would have cost at the hinted tier
(`saved = Σ price(hint tier) × tokens − cost`), and tokens handled by flat-rate agents. Marked as an estimate. The
orchestrator header shows the project budget as `spent / budget` when one is set.

## Not in scope

Proxying subscription vendors' private HTTP endpoints through the router (see the subscription design, S3b).
Changing the ladder's models (owner decision pending: by catalogue prices the `high` tier is the cheapest).
