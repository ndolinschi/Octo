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

## As built — I1, harness side (2026-11-11)

Built in `apps/harness` (packages `internal/router`, `internal/budget`, `internal/fakerouter`; type-only additions in
`packages/agent-client`). Verified by the orchestrator: Go gates, and `apps/harness/scripts/e2e-router.sh` against the
real router with a mock upstream — acceptance 1, 2 and 5 pass. **Not verified against the real router:** compaction
(acceptance 4; the mock upstream cannot produce it — covered with the fake router only), the served tier under
`ceiling` / `fixed` (acceptance 3; covered separately on each side, not jointly), a real classifier, a real upstream.

- **The base URL must be the router's autoroute path** (`--base-url http://host:port/autoroute`); hints and result
  headers exist only there.
- Detection runs at start-up; a router that appears later is found by a re-probe at most once a minute.
- Last known spend = `x-octo-spent-usd` + the call record's cost; `spent_usd` in project JSON is the larger of that
  and the usage-row sum (`null` while nothing has a cost).
- A call record of `cost_usd: 0` / `estimated` is treated as "no price": the harness estimates from its own
  `prices.toml` by served model, else reports `null`.
- A 402 writes a zero-token usage row; the error reaches every parent so the turn ends.
- A compaction summary is stored in a `compactions` table (`upto_message_id`), not as an assistant message; the UI
  does not show it and no event is emitted (to do with the UI pass: a "History compacted" marker).
- The budget header is read at the start of a turn; a PATCH mid-turn applies to the header from the next turn.
- New API fields: `GET /v1/config` `router`, `router_capabilities`; project `budget_usd`, `spent_usd`,
  `models.tier_policy`.

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

## As built — I2, router side (2026-11-11)

`POST /autoroute/v1/route` (capability `route_api`; details and the policy table: `apps/router/docs/autoroute.md`,
"Routing decision for delegation"). Verified by the orchestrator: fmt, clippy, 252 tests (33 new) with no proxy and
no network. **Not verified:** a real classifier — its latency and the quality of its bands.

- One classifier (JEV) call per decision, 2 s timeout (`[autoroute.route] classifier_timeout_ms`; 0 = never call).
  When it cannot run the band comes from a text rule (stack trace or two signals → hard; short with no signals →
  easy; else medium) and `reason` says the classifier was not used. The request never fails because of it.
- Ranking among able candidates: logged-in flat-rate agents (most limit left first), then API tiers by blended
  price, then other agents. An agent with no `strengths` is able for easy and medium; hard goes to the deep tier
  unless `prefer_flat_rate_for_hard`. Logged-out or exhausted agents are never chosen.
- Budget reached: no classification; a flat-rate agent if any, else 402 (header budget) or the configured action.
- The decision is a call record (`trigger: "route"`, a `route` object) and its classifier cost counts against the
  budget key.
- **The harness waits 2500 ms**, not the 300 ms first written above: a sub-agent runs for minutes, and a timeout
  shorter than the classifier's would make the harness fall back most of the time.

## As built — I2, harness side (2026-11-11)

Verified by the orchestrator: Go gates, `scripts/e2e-router.sh` case 6 against the real router (the decision and its
call record; the mock upstream cannot classify, so the router used its text rule). **Not verified:** a real
classifier, real agent CLIs.

- `spawn_agent` takes `tier: "auto"`, the default when the router announces `route_api` (`GET /v1/config`
  `route_api`). An explicit tier or an explicit `agent` is never routed.
- Candidates: the API tiers (when the built-in loop is available and the tier is not itself mapped to an agent) and
  every available ACP agent (`acp:<id>`; logged-out agents are sent as such, agents whose probe has not answered
  are left out). Manifest fields `flatRate` and `strengths`; `models.auto_candidates` restricts and orders the set.
- The agent records `route_choice`, `route_reason`, `route_band`, `route_request_id`. The classifier's cost is a
  usage row with role `route`.
- Fallbacks never fail a turn: no router, timeout, 5xx, 422 or an unknown choice → the balanced tier (or the first
  logged-in agent when there is no key), with the reason recorded; 402 → the budget failure.
- `flatRate` in the built-in manifest is a judgement: true for claude-code, codex, copilot, cursor, antigravity,
  devin; false for grok, droid, opencode, omp, pi.

## As built — call records and spend survive a restart; I1 acceptance 3 and 4 over HTTP (2026-11-11)

Supersedes "call records are kept in memory only" above. Verified by the orchestrator: fmt, clippy, 264 tests with
no proxy. **Not verified:** a real upstream or classifier; behaviour against a large database.

- Call records are written to the history database (`autoroute_calls`; no prompt text) and read back by
  `GET /autoroute/v1/calls/{id}` when not in the in-memory cache; the history row of a proxied call carries the
  request id.
- Spend per budget key has its own table and is restored on the key's first request in a process, so
  `x-octo-spent-usd` and budget rejection are right after a restart (and after an idle hour, which used to reset
  it). It is not derived from the records, which are pruned (30 days / 100 000 rows by default; spend 90 days idle).
- Writes are off the response path; a kill within milliseconds of a call finishing loses that call's record and
  spend increment.
- New HTTP-level tests: `ceiling` never serves above the hint across a stalled session the classifier calls hard
  (the `auto` control does escalate); `fixed` serves the hint every turn with no classifier call; a compaction round
  trip applied by the client is not repeated; one ignored by the client is forwarded once as `compact_not_applied`.

## Decisions after the owner's live run (2026-11-11)

The owner ran the branch with real Claude Code over ACP, a real router and the real classifier (`typesafe/jev-1.13`
answered in 49–93 ms; an easy task went to Claude Code on the subscription, a hard one to the deep tier).

1. **Never pay more for less** (closes the open "ladder inverted by price" decision). Measured for 30k in / 500
   out: low $0.0096, mid $0.0048, high $0.00043. The ladder's order stays (it is by capability); the router serves
   the cheapest tier at or above the decided one (`[autoroute] never_pay_more_for_less`, default on; `ceiling`
   bounds it, `fixed` turns it off). The stale `low` price in `prices.toml` is corrected.
2. **A flat-rate agent's cost estimate is not spend.** It is stored as an estimate, shown as "≈ $X on your
   subscription", and excluded from the project's spend, budget checks and paid totals.
3. **One budget number.** With a router in the path its spend is authoritative; the orchestrator's own turn and
   delegation stop on the same condition.
4. **Hard tasks may go to a subscription.** Built-in manifest: `strengths` easy/medium/hard for claude-code and
   codex, easy/medium for copilot and cursor. Changeable in a copied manifest.
5. The app's sidecars exit when the app dies (stdin close), not only on a clean quit.

## I3 — showing the savings (after I2)

Usage → Cost gains "Auto-routing": actual cost vs. what the same tokens would have cost at the hinted tier
(`saved = Σ price(hint tier) × tokens − cost`), and tokens handled by flat-rate agents. Marked as an estimate. The
orchestrator header shows the project budget as `spent / budget` when one is set.

## Not in scope

Proxying subscription vendors' private HTTP endpoints through the router (see the subscription design, S3b).
Changing the ladder's models (owner decision pending: by catalogue prices the `high` tier is the cheapest).
