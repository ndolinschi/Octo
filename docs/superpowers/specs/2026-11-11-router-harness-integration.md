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
- `x-octo-spent-usd` is the spend **before** the response it is on. The post-call figure is `spent_after_usd` in the call record (see "As built — spend after the call").
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

## As built — price rule, low price, exit with the parent (router, 2026-11-11)

Verified by the orchestrator: `cargo fmt --check`, clippy with `-D warnings`, 302 tests with the proxy variables
removed. **Not verified:** a live upstream run; the low-tier price against a billed call (the owner's figure was
taken as given; the catalogue was not re-fetched).

- `[autoroute] never_pay_more_for_less` (default true): after a tier is decided, a tier above it (up to the ceiling)
  that is strictly cheaper for this request's shape is served instead. Ties and unpriced tiers never swap;
  `tier-policy: fixed`, `custom`/unset tiers and passthrough are never swapped. The session remembers the decided
  tier, so a steady swap is not reported as rerouting.
- A swap is visible as `x-octo-decided-tier` + `x-octo-price-swap: 1` (`x-octo-model`/`x-octo-tier` stay "what was
  served"), as `decided_tier` in the call record, and in the route endpoint's estimates, `model` and `reason`.
- `prices.toml`: low tier 0.051 / 0.567 per million. The ladder is still inverted for a 30k-in / 500-out request
  (low 1,813, mid 4,800, high 430 micro-USD), so with the rule on both low and mid are served by high; the start-up
  warning says so.
- `OCTO_EXIT_ON_STDIN_CLOSE=1`: the router shuts down gracefully when stdin closes (tested against the real binary).
- Open: the history `calls` table stores only the served tier.

## As built — fixes after the live run (harness, 2026-11-11)

Verified by the orchestrator: `gofmt`, `go vet`, `go test -race ./...`, `scripts/e2e-router.sh`,
`scripts/e2e-acp-orchestrator.sh`, agent-client lint and tests, `packages/ui` type-check. **Everything ran against the
scripted agent and the fake router**; nothing here was confirmed with Claude Code, Copilot or the real router.

- **Flat-rate cost is not spend.** Usage rows gain `flat_rate`; a flat-rate agent's figure is stored as an estimate,
  left out of `spent_usd`, budget checks and cost totals, and reported as `subscription_equivalent_usd`. An ACP
  orchestrator's cumulative `usage_update` counters now live with its session, so a turn no longer records the whole
  session again (the likely source of the $0.53). Gap: after `session/load` into a new process an agent that continues
  its old counters is counted twice once. Assumption not checked live: the real counters are cumulative per session.
- **One budget number.** With a router that announces `budget_key`, spend is the router's figure; estimates are never
  counted. The orchestrator's own requests pass the same gate as delegation (the router's 402 stays as backstop), and
  the budget header is read per request.
- A delegation refused for budget creates the child row and settles it `failed` with the reason.
- An ACP orchestrator that cannot start ends the turn `failed` with the message and the manifest hint (already the
  case at this level; **the silence the owner saw with Copilot was not reproduced** — a transcript is needed).
- Manifest `requires: string[]` → `available: false` + `unavailable_reason`. Built in: only `pi` (its command is
  `npx`); `claude-code` and `codex` were left without it (their adapters are said to bundle the CLI — unverified).
- Tool rows titled `mcp__octo-harness__<tool>` (and three other spellings) are stored under the tool's own name; the
  sub-agent link matches by arguments first, then title and timing.
- `--exit-on-stdin-close` / `HARNESS_EXIT_ON_STDIN_CLOSE=1`: graceful shutdown when stdin closes (tested with a real
  process).
- Child environment: 24 more names pass (`GIT_*` config, `PKG_CONFIG_PATH`, `LD_LIBRARY_PATH`, `DOCKER_HOST`,
  `KUBECONFIG`, `RUSTUP_TOOLCHAIN`, `AWS_PROFILE`, `AWS_REGION`, `AWS_SHARED_CREDENTIALS_FILE`, …); keys, tokens and
  `GIT_ASKPASS` stay dropped.
- `turn.finished` is published after the turn's slot is released (probable cause of the flaky load-session test; the
  flake itself was not reproduced). A prompt that fails because the agent had just died restarts the agent once.
- `strengths` defaults as decided above.
- **v7 groundwork is in the same tree** (changes and diffs, approvals, queue, forms and the secret store): it
  compiles and its unit tests pass, but docs, client types, `serve` wiring and `scripts/e2e-v7.sh` are not done.
  Visible already: `POST /messages` during a turn answers 202 `{queued}` instead of 409; `request_input` is registered
  for every agent.

## Owner's live run 2 (HEAD a375955, Linux box, 2026-11-11) — findings and decisions

**Confirmed live by the owner:** clean build, `install.sh` single pass, sidecars die with the app (< 1 s), light
first frame on Linux, Claude Code over ACP as orchestrator and sub-agent (file question, delegation shown as
`spawn_agent`, same session, stop, logged-out error), logged-out Copilot and Grok fail visibly, price-swap headers,
budget stop, router cost = OpenRouter bill, memory search for some word forms, context receipts.
**Still blocked on the owner's logins:** Copilot and Grok beyond the logged-out case.

Decisions (each becomes a fix with a test):

1. **The packaged router must have its full configuration.** The app wrote only `server/limits/history.toml`, so
   the router ran without prices, the ladder and provider settings; the price rule and budget routing were off.
   The router embeds its default `prices.toml`, `autoroute.toml` and `openrouter.toml` and uses them for any file
   missing from its config directory (a file present on disk wins); start-up logs which defaults were used.
2. **One spend number, for real.** Harness $0.003305 vs router $0.003390: the harness summed call records and
   missed the classifier's own cost. The harness takes the router's reported spend (`x-octo-spent-usd`, highest
   value seen for the budget key, also when two calls finish out of order) and never sums on its own in router mode.
3. **Usage contract for subscriptions:** every bucket and row carries `flat_rate: boolean`, `cost_usd` (spend only,
   0 for flat-rate) and `subscription_equivalent_usd`. The UI shows "≈ $X on your subscription" from the latter.
   Demo fixtures are generated from the same Go structs' JSON (a contract test) — the demo looked right while the
   real API did not.
4. **Grok on a subscription is flat-rate** unless `XAI_API_KEY` is forwarded to it; then it is spend.
5. **Agent facts from the live run go into the manifest:** Grok install (`npm i -g @xai-official/grok` or the x.ai
   install script), login `grok login` / `grok login --device-auth` on a headless machine, `--no-auto-update`, auth
   method `grok.com` treated as "interactive login needed" with a plain message; login probes for Grok
   (`grok models` → "not authenticated") and, if a non-interactive status command exists, Copilot; Codex is
   `available` only when its adapter can actually start, and has an install line.
6. **Errors are written for the user.** "acp rpc error -32000: Authentication required" becomes "<agent> is not
   logged in" with the hint in a separate `hint` field (the UI showed it twice because it was also inside the text).
7. **`harness doctor` describes the app the user runs:** default data directory = the desktop app's when it exists
   (and says which one it used), reads `harness.env`, reports the trace setting and files correctly, explains
   "router is started by the desktop app" instead of looking broken, de-duplicates PATH.
8. **ACP usage:** output tokens are recorded (they were 0); a cancelled turn is stored and shown as stopped.
9. **Memory, from real use.** A request does not automatically become an open task: trivial exchanges (no tool,
   short answer) get no task record; a follow-up joins the task it continues (the digest decides, the orchestrator
   may override); a finished turn closes its task with an outcome; a cancelled one is `dropped`; `files` is
   filled from the turn's tool calls. Search gets a Russian stemmer at index and query time and folds ё/е (the
   trigram fallback missed "-ами", "скобок/скобками", "Молдове/Молдовы"). `window` context cost 15% more than
   `full` on a real caching provider (uncached input 2.2×): it stays opt-in, and its window now advances in steps
   (every `recent_exchanges` requests, not every request) so the prefix stays cacheable between steps.
10. **Router details:** `x-octo-tier-hint` accepts `low|mid|high` as well as `fast|balanced|deep` and rejects
    anything else with 400 instead of ignoring it; low `cache_read` 0.018; when a reported cost differs from the
    table estimate by more than 25% the router logs it once per model and exposes the ratio in the call record
    (the provider actually used was dearer than the catalogue price); the upstream generation id is stored when
    the upstream returns one.
11. **Traces** redact e-mail addresses.

## As built — live run 2 (router)

Items 1 and 10 of the findings above, in `apps/router/`.

1. **Embedded default configuration.** `src/config.rs` embeds the shipped `config/openrouter.toml`, `autoroute.toml`
   and `prices.toml` (`include_str!`). A config directory missing any of the three uses the embedded text for it; a
   file on disk replaces the embedded one as a whole (no merge with the embedded text). The other fragments keep their
   serde defaults; `server.toml`, `limits.toml` and `history.toml` stay the shell's (the desktop shell writes exactly
   those three). Start-up logs one INFO line naming the embedded files. `Config::load_directory_with_report` returns
   the list. Tests: `tests/embedded_defaults.rs` (shell-shaped directory loads prices, ladder, provider settings and
   swaps `low` to `high` like the full dev config; an on-disk `prices.toml` and a partial `autoroute.toml` win).
2. **Tier hint.** `x-octo-tier-hint` accepts `low|mid|high` and `fast|balanced|deep`, case-insensitive; any other
   non-empty value is a 400 `invalid_request_error` naming the accepted values (nothing reaches the upstream). The
   harness only sends `fast`, `balanced` or `deep` (`projectstore.Tier`, `apps/harness/internal/orchestrator/route.go`),
   so nothing it sends starts failing. `Hints::take` now returns a `Result`.
3. **Prices.** low `cache_read` 0.018 (dated comment in `prices.toml`); `docs/ladder-cost-check.md` updated.
4. **Estimate vs bill.** When an upstream-reported cost differs from the table estimate by more than 25%, the call
   record has `estimate_ratio` (reported / estimated, 2 decimals) and one WARN per model per process is logged. The
   charge is unchanged (reported wins).
5. **Generation id.** The call record has `upstream_id`: the OpenRouter generation id (`gen-...`, from the
   `x-generation-id` header or the response `id`). On a response that carries only an Anthropic-style `msg_...` id
   that id is stored as it is and is not a generation id; no mapping is invented.

Existing tests changed: `tests/harness_integration.rs` (`Hints::take` returns a `Result`; the case "invalid tier hint is
ignored" now is a 400, covered by new tests; the ignore-test keeps the other invalid hints) and `tests/call_persistence.rs`
(new `CallRow` fields). Not verified: nothing was run against a real upstream; that OpenRouter's Messages path returns
a `gen-` id in the response `id` is assumed from the existing parsing, not observed.

## As built — review fixes (router)

Ten defects from an independent review of the price rule, embedded configuration and stdin code, all in `apps/router/`;
tests in `tests/review_fixes.rs`, `tests/embedded_defaults.rs`, `tests/price_rule.rs`, `tests/route_api.rs`.

1. **Windows.** The price swap only targets a tier whose window holds the request (75% fill rule), or, when the decided
   tier does not hold it either, one with a window no smaller; a model chosen by the fill `upgrade` is never swapped
   (`Limits.no_swap`). The no-swap guard is defensive: with the window check it is hard to reach, so only the window
   behaviour has a behavioural test.
2. **Retry.** A swapped call whose model is unavailable retries on the decided tier's model before `next_up`.
3. **Compaction fallback** honours the ceiling and is absent under `fixed` (`RepeatCompact.limits`).
4. **Merge order.** Embedded fragments first, then every on-disk file: a key on disk wins whichever file holds it.
5. **Stdin.** `Interrupted` retried, `WouldBlock` polled (50 ms), only EOF or a hard error stops.
6. **Partial rows** (`rates_complete` false) are unpriced in `blended_cost_micros`.
7. **Route endpoint:** the swap is limited to offered API tiers.
8. **Budget check on escalation** compares the band the rule would serve (`EscalationShape`).
9. **Estimate ratio:** none under 100 micro-USD, estimate from the response's model when it has a price row (none when it
   names an unpriced different model), WARN at most once per model per hour.
10. **Tier hint:** a non-ASCII value is a 400; repeated headers must all be valid and agree.

Existing tests changed: `route_api.rs` (the single-low-candidate swap test now asserts no swap to an unoffered tier),
`harness_integration.rs` (`ResolvedCost` literal). Not verified: no live upstream; `no_swap` has no dedicated behavioural test.

## As built — live run 2 (harness)

Items 2 to 9 and 11 of "Owner's live run 2", in `apps/harness/` and `packages/agent-client/`. Details: `apps/harness/docs/architecture.md` ("Live run 2 (harness)"), `docs/memory.md` ("Task records over a turn"), the harness README ("Diagnostics").

2. **One spend number.** Router-mode spend is the highest `x-octo-spent-usd` seen per budget key (`NoteSpent` keeps the maximum), not a sum of rows. The header excludes the response it travels with, so after a call the harness uses the call record's `spent_after_usd` if the router provides it, else header + the call's cost; with the header alone the figure can lag the router by the last call's classifier cost until the next call. **Ask for the router side:** a post-call figure (`spent_after_usd` in the call record, or a header meaning "after") would make the two numbers equal at all times; the harness already reads `spent_after_usd`. Tests: fake router with `ClassifierUSD`, `SpentAfter`, `DelayFor` (three overlapping calls finishing in reverse order end at the router's exact figure).
3. **Usage contract.** `flat_rate`, `cost_usd` (0 for flat-rate only), `subscription_equivalent_usd`, `tokens_estimated` on every bucket; fixtures `packages/agent-client/src/fixtures/usage.api.json`, `usage.flat.json`, `usage.mixed.json` come from the real HTTP response (`TestUsageContract`; agent-client tests read them).
4. **Grok flat-rate unless `XAI_API_KEY` is forwarded**, generalised as manifest `billingEnv`, decided at spawn from the resolved environment; claude-code lists `ANTHROPIC_API_KEY`. Cursor, Devin, Droid and Copilot forward keys that only authenticate their own plan or token, so they are not listed.
5. **Manifest facts.** Grok install `npm install -g @xai-official/grok`, login `grok login` / `grok login --device-auth`, probe `grok models` with `auth.notLoggedInPattern` ("not authenticated"), command line unchanged (`--no-auto-update` only in the install text). Copilot: no probe, login unknown (no sourced status command). Codex: `requires: ["codex"]` and an install line. Probes tested with fake scripts only; no CLI was run.
6. **Auth errors** become `<label> is not logged in`, hint in `hint` (turn.finished) / `error_hint` (agent row) only.
7. **Doctor** uses the desktop app's data directory when it exists (path logic duplicated from the shell, not imported), says which and why, loads its `harness.env`, configures the trace before reporting, explains a router the app starts, lists PATH entries once.
8. **ACP usage** records output tokens (reported by the prompt response when the agent sends `usage`, else estimated and marked `tokens_estimated`); cancelled turns keep their text with `stopped: true`; late tool input is stored (`message.updated`).
9. **Memory.** (a) trivial exchanges leave no record (decided at turn end, with the digest deciding when it is on); (b) the digest may answer `continues: <task id>`; (c) completed closes (`done` + outcome), cancelled drops; (d) `files` from tool calls; (e) Russian Snowball stemmer + ё fold + fleeting-vowel fold in a third FTS index, rebuilt on migration (schema 5); (f) the window advances in steps of `recent_exchanges` and its volatile blocks (tasks, facts) moved after it so the prefix is stable between steps (`window` stays opt-in).
11. **Trace** redacts e-mail addresses.

Not verified: nothing was run against a real router, Claude Code, Grok, Copilot or Codex. Whether a real Claude Code reports `usage` on `session/prompt` (the harness handles both cases) is for the owner's trace to show; whether `window` now costs no more than `full` on a real caching provider is likewise not measured here (the test proves the byte-identical prefix, not the bill). The stemmer's behaviour on words outside the test corpus (irregular forms) is the standard algorithm's; the fleeting-vowel fold trades some precision for recall (`сон`/`сна` meet, as do a few unrelated words).

## As built — spend after the call

Closes the "ask for the router side" of live run 2, item 2.

- **Router.** `CallRow.spent_after_usd` (`apps/router/src/auto/calls.rs`) is set for every call charged to a budget key (the
  key from `x-octo-budget-key` or the one bound to the session): `Auto::charge` now adds the cost and reads the key's spend
  under one ledger lock and returns it, so overlapping calls each get a figure that includes their own cost and the highest is
  the key's spend. It covers the proxy path (non-streamed and streamed; the figure is taken when the response has finished),
  compaction and the route endpoint (the classifier's cost; a call that costs nothing still reports the current spend). Calls
  without a budget key have no such field. It is also in the persisted record. The micro-USD figure is serialised as USD
  (f64), exact to six decimals.
- **No header or SSE trailer.** `x-octo-spent-usd` stays "before this response": a streamed response's cost is known only after
  the headers are sent, and the harness reads the call record after every response (`FetchCall`, which already retries a 404
  once), so a final SSE comment/event would add a second path nothing consumes. Not built on purpose.
- **Harness.** `Call.SpentAfterUSD` was already read (`internal/agent/route.go`); nothing changed there. The fake router now
  mirrors the real behaviour: `spent_after_usd` on every keyed call by default, `NoSpentAfter` for an older router.
- **Tests.** Router: `tests/harness_integration.rs::call_record_carries_the_post_call_spend_of_the_budget_key` (two buffered
  and one streamed call, the next header equals the previous post-call figure, no key means no field), `tests/route_api.rs`
  (classifier cost). Harness: `TestRouterSpendAfterConcurrentCallsFinishingOutOfOrder` (three overlapping calls with classifier
  cost, finishing in reverse order, harness and router equal to the micro-USD); `TestRouterModeSpendIsTheRoutersNotASumOfRows`
  runs with `NoSpentAfter` to keep covering the older-router path.
- **Not verified:** against a real router process end to end beyond `scripts/e2e-router.sh` (see the run notes); no real upstream.

## As built — a cut-off stream is an error, not an answer (2026-11-19)

Router (`providers/utils.rs`, `Tee`): a 2xx `text/event-stream` Messages or chat response that ends without its terminator
(`message_stop` / `[DONE]` / an error event from the upstream itself, looked for in the last 1 KiB) or breaks off with a
transport error used to end as a plain 200 (or abort the connection). The client now gets, after a blank line that closes a
half-written event, `event: error` with `{"type":"error","error":{"type":"api_error","message":"The connection to the model
broke off before the response was complete. Try again."}}` (chat: a `data: {"error":...}` chunk), the body closes cleanly, and
history records the call as 502 (tokens and cost as before). A non-SSE body that fails after headers is unchanged (header
status kept). Verified: `tests/stream_cut.rs` (six tests on a raw-socket fake upstream, `support::spawn_sse_server`, that
really cuts the stream: transport cut, clean stop, cut mid-event, complete stream untouched, upstream's own error event not
doubled, chat with and without `[DONE]`); the four cut-off cases failed before the change (the other two are controls). `SSE_OK` in `harness_integration.rs` gained the
`message_stop` a real stream ends with.

Harness side: it already handles the event. The Anthropic SDK turns `event: error` into an `*anthropic.Error` on
`stream.Err()` (checked with a throw-away test against an `httptest` server sending the router's event), so the turn fails
and keeps the text it had. But `describe` files it under `model_call_failed` ("The model did not answer.", the router's
sentence in the details), not `model_unreachable` ("The connection to the model broke off."): a follow-up could map an
`api_error` stream event to `ModelUnreachable`/`RouterUnreachable`. Not changed (out of scope). Not verified: a full turn
through a real router with a cut upstream.

## As built — delegation records, outcomes and escalation (2026-11-20)

For the learned-router thesis (`2026-11-13-learned-router-design.md`): every I2 decision now leaves a labelled record.

- Router: `POST /autoroute/v1/route` writes a `delegations` row (task as seen, candidates, decision, classifier, estimate;
  the brief text only with `store_payloads`, else lengths, a salted HMAC hash and derived text features). New
  `POST|GET /autoroute/v1/route/{id}/outcome` (capability `route_outcome`) stores append-only, idempotent reports
  (`finished`, `redelegated`, `escalated`, `rewound`, `reverted`) and derives `solved` = yes / no / unknown by one written
  rule (`apps/router/docs/history.md`, "The `solved` label", with its known noise). The route request takes `exclude`,
  `min_tier`, `attempt`, `escalated_from`, `session_id`, `task.parent_tier`. `[autoroute.delegation] classifier = "jev" |
  "heuristic" | "learned"` (default `jev`, today's behaviour; `learned` is declared only and falls back to the heuristic,
  reason recorded; no ONNX or tokenizer dependency). `octo export-delegations --out f.jsonl [--redact]` writes schema
  `octo.delegation.v1`.
- Harness: reports `finished` (status, the sub-agent's could-not signal, usage from its rows and messages, duration, its
  router session), re-delegations, rewinds and reverts, fire-and-forget with a bounded retry, only to a router announcing
  `route_outcome`. Escalation on failure (`HARNESS_DELEGATION_ESCALATE_ON_FAILURE`, default off): one retry of the same
  brief on a fresh sub-agent, the failed choice excluded and the next tier as the floor; never for a stop or a budget
  failure, never twice. The retry's `route_reason` begins "Retried on … after …", which the existing activity row shows; no
  UI change.

Verified here: `cargo test -p octo` (new `tests/delegations.rs`, 16 tests), clippy, fmt; `go test ./...` (new
`internal/orchestrator/delegation_test.go`, `delegation_internal_test.go`, `internal/router/outcome_test.go`); and
`scripts/e2e-router.sh` cases 7 (record, outcome, label, export with and without `--redact`) and 8 (a sub-agent served by
the mid model answers "Could not do it", the harness escalates once to `deep`, the two records are linked) against the real
router, the mock model and the router's text rule (the mock cannot classify). Not verified: a real model or agent CLI,
the JEV classifier deciding a delegation for real, test summaries parsed from a real sub-agent's run feeding the label, an
ACP sub-agent's outcome against the real router (covered by the fake router only), and how noisy the label is in practice.
