# Autoroute

Autoroute is the session-aware model ladder for Claude Code → OpenRouter. It lives behind dedicated paths so passthrough behavior stays unchanged.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/autoroute/v1/messages` | Primary Claude Code path; compaction + retry + text-tool-call hook |
| `POST` | `/autoroute/v1/chat/completions` | Same decide/shape; **no** Messages compact API; no text-tool-call hook |
| `GET` | `/autoroute/status` | JSON for statusline (`?session=` optional) |
| `GET` | `/autoroute/v1/calls/{request-id}` | Final tokens and cost of one finished call (see [Harness integration](#harness-integration)) |
| `POST` | `/autoroute/v1/route` | Routing decision for a delegated task: which candidate (API tier or subscription agent) should do it (see [Routing decision for delegation](#routing-decision-for-delegation)) |

Ladder slugs and policy: `config/autoroute.toml` (default: `deepseek/deepseek-v4.1-flash` → `minimax/minimax-m3.1-flash` → `deepseek/deepseek-v4.1-flash-1017`; no `provider_order` pin; `allow_fallbacks = true`).

## Decide pipeline

Order inside `auto::decide` (simplified):

```mermaid
flowchart TD
  in[Request body]
  perm{permission_check?}
  hk{housekeeping?}
  bg{background_by_client_model<br/>+ bg_signal?}
  await{awaiting_compact?}
  stall{stall detect}
  hold{hold / tool_results_only?}
  jev[JEV classify<br/>is_hard / is_easy / tools_enough]
  sticky[Sticky + budget cap]
  route[route::run]
  shape[body::shape]
  fwd[Forward / Compact]

  in --> perm
  perm -->|yes| route
  perm -->|no| hk
  hk -->|yes| route
  hk -->|no| bg
  bg -->|yes| route
  bg -->|no| await
  await -->|repeat compact| fwd
  await -->|else| stall --> hold
  hold -->|yes| sticky
  hold -->|no| jev --> sticky
  sticky --> route --> shape --> fwd
```

### Triggers (examples)

| Trigger / reason | Meaning |
| --- | --- |
| `permission_check` | Keep sticky model; skip JEV |
| `housekeeping` / `housekeeping_trimmed` | Force low; optional message trim |
| `background_model` | Same as housekeeping when opt-in flag on |
| `stall:error_streak` / `stall:tool_*` | Escalate one band for `escalate_turns` |
| `text_tool_call` | Next-turn escalate after detector fires |
| `none` | Empty question passthrough (still shaped) |
| JEV band names | Complexity from Decisions scores |

## Body shaping (`shape`)

Applied on every Forward (including “passthrough” unset tier):

```mermaid
flowchart LR
  body[Client JSON]
  model[Rewrite model slug]
  think[Strip thinking on model change]
  clamp[Clamp max_tokens]
  strip[Remove strip_fields keys]
  req[Inject provider.require_parameters]
  pin[Optional provider_order]
  out[Upstream body]

  body --> model --> think --> clamp --> strip --> req --> pin --> out
```

Shipped strip list (Anthropic-only; proven against destinstral `supported_parameters`):

- `output_config`
- `safeguards`
- `context_management`

`require_parameters` modes: `always` | `tools_only` | `never` (invalid values fail config load). Empty `strip_fields` disables stripping — do not leave `require_parameters=always` with an empty list unless you accept OpenRouter 404s.

Protected keys (`tools`, `tool_choice`, `system`, `messages`, `max_tokens`, `stop_sequences`, `metadata`) are never stripped even if listed.

## Price rule: never pay more for less

`[autoroute] never_pay_more_for_less` (default `true`). Whenever the router has decided a ladder tier **T** for a request, whatever picked it (classifier, hint, sticky hold, stall escalation, housekeeping/background routing, fill `upgrade`, budget cap, the unavailable-model retry escalation, a permission check on a remembered session), the tier **served** is the cheapest tier among T and all tiers above T, by the `prices.toml` blended estimate for that request's shape (estimated input tokens and `min(max_tokens, 1024)` output, the same shape budget routing uses).

| Case | Behaviour |
| --- | --- |
| Ties | The lower tier wins (a higher tier is served only when strictly cheaper) |
| Unpriced tiers | A tier without a usable price (missing, partial or all-zero rates) is never preferred over a priced one; if T itself is unpriced, T is served |
| `tier-policy: ceiling` | Candidates are T up to the ceiling only |
| `tier-policy: fixed` | The rule does not apply |
| `custom` (client-preferred high model via `high_allow`), passthrough without a tier decision | Not swapped |
| Rule off | Today's behaviour: the decided tier is served |

Only the served model changes. The session still remembers the **decided** tier T (`sticky_band` and the remembered model), so hysteresis, stall and sticky logic are unchanged; the next turn is decided and priced afresh. Context-window checks, compaction, the retry and `x-octo-tier` all use the served model. Because the served tier is part of the history `tier_before` (computed the same way from the remembered tier), a steady swapped session does not report `rerouting` every turn.

Reporting: `x-octo-model` and `x-octo-tier` are what was served; when the rule changed the tier, `x-octo-decided-tier` carries T and `x-octo-price-swap: 1` is set (a separate header, the `x-octo-trigger` value is not altered). The call record gains `decided_tier` (absent without a swap). The history `calls` table keeps the served tier in `tier_after`; it has no decided-tier column. The retry after a model-unavailable failure decides the tier above the served one and applies the rule to it; if the served tier is already `high` there is no escalation.

The `POST /autoroute/v1/route` endpoint applies the same rule to API candidates: candidate ids are kept as offered, but each API candidate's `estimated_cost_usd`, its ranking and the returned `model` are those of the tier that would really be served; the `reason` then ends with a `Price rule:` sentence and the call record has `decided_tier`.

On the shipped ladder (`docs/ladder-cost-check.md`) the most capable tier is the cheapest for a nominal request, so `low` and `mid` decisions are served by `high`.

## Sticky, stall, budget

| Mechanism | Behavior |
| --- | --- |
| Sticky band | Session remembers low/mid/high; down-tier needs `down_confirm` consecutive lower classifications |
| Stall | Looks at last `stall_window` non-HK assistant turns; escalates and holds `escalate_turns` |
| Session budget | **Default `session_budget_usd = 0` means OFF: no cap, no refusal.** When `> 0` and spend reaches it: `session_budget_action = "downgrade"` (default) routes to the **cheapest** tier by `prices.toml` (blended estimate for the request's input and `max_tokens`; legacy "mid" cap if the ladder is not fully priced); `"reject"` returns HTTP 402 `billing_error` (Anthropic error shape) with the budget and spend, before any upstream or classifier call |
| Budget key | Header `x-octo-budget-key` makes spend (and the budget) shared across every session sending the same key; stripped before upstream; see [Harness integration](#harness-integration) for `x-octo-budget-usd` |
| Classifier failure | New session and the JEV call fails: use `classifier_failure_tier` (default `mid`), remember it like any decision (trigger `classifier_failure`), retry classification on the next user turn. A missing API key still passes through unclassified |
| Classifier input | Last user text sent to JEV is capped at 2000 characters (head + tail with an omission marker) |
| `max_tokens` | Missing client value becomes `default_max_tokens` (default 8192), capped by the model maximum; explicit values are respected, also capped by the model maximum |
| high_allow | Client preferred model on High only if allowlisted (empty = always use configured high slug) |

Caveats: [status.md](./status.md).

## Compaction and retry (messages)

```mermaid
flowchart TD
  overflow{fill >= 0.75 or stop reason?}
  compact[POST compact-2026-09-04 once]
  ok[Stream to client]
  unapplied{next request shrunk?}
  fwd[Forward normally, suppress compaction, trigger compact_not_applied]
  fail{429 / 5xx / connect?}
  same[Wait Retry-After, retry same tier once]
  up[Model unavailable: retry next tier once]
  err[Error to client]

  overflow -->|messages + allow_compact| compact --> unapplied
  unapplied -->|yes| ok
  unapplied -->|no| fwd
  overflow -->|chat| ok
  fail -->|before client bytes| same --> ok
  fail -->|model unavailable| up --> ok
  fail -->|exhausted| err
```

- Messages autoroute: OpenRouter compaction, **at most one compaction call per threshold crossing**. If the next request from that session has not shrunk (the client did not apply the summary), Octo logs a warning, forwards the request normally with trigger `compact_not_applied` in history, and does not compact that session again until its request falls below the fill threshold and rises again (or after `compact_cooldown_requests` further requests when set). Toolless requests carry no session state, so they are not tracked.
- Retry (messages route, before any client bytes): 429, 5xx, and connect/timeout errors get **one** retry. The wait honours `Retry-After` (seconds or an IMF-fixdate HTTP date), bounded by `retry_after_max_secs` (default 10). The retry goes to the **same tier**; it goes to the next tier up only when the error body says the model/provider is unavailable (`No available model provider`, `No endpoints found`, `model_not_available`, `model is (not available|unavailable)` on a 429/5xx) and the budget allows that tier. Other 4xx are never retried. There is never a second retry.
- Chat autoroute: `allow_compact=false` for overflow decide; if a Compact turn still appears, `chat_compact` strips compaction and forwards as normal chat. No retry on chat.

## Session identity

`session_key` is derived only from the request body: `metadata.user_id` (JSON string) → `session_id`, then optional `#sub:{hash}` for Claude Code Agents. The hash is SHA-256 of the **first** user message text (stable across tool_result turns). `calls.parent_session_id` stores the parent UUID. New subagent sessions default to the **low** tier on first turn.

## Observe signals (history only unless flags on)

| Signal | Source | Routing effect by default |
| --- | --- | --- |
| `client_model` | Preferred model in body | None |
| `client_has_thinking` | Thinking blocks present | None |
| `client_tool_names` | Tool name CSV | None |
| `bg_signal` | Model matches `background_model_patterns` | None unless `background_by_client_model` |
| `hk_text_signal` | Housekeeping text patterns | Housekeeping path when text matches |

## Server tools

`web_search` / `web_fetch` / `code_execution`:

| `server_tool_mode` | Behavior |
| --- | --- |
| `passthrough` (default) | Forward unchanged |
| `online_suffix` | Rewrite model with `:online` |
| `reject` | 400 before upstream |

## Statusline

`GET /autoroute/status?session=…` returns spend / model JSON for `scripts/statusline.sh`.

## Harness integration

Integration I1 of [`docs/superpowers/specs/2026-11-11-router-harness-integration.md`](../../../docs/superpowers/specs/2026-11-11-router-harness-integration.md). The harness detects the router with `GET /health`, tells it what a request is for (hint headers), and reads back what the router did (result headers, the calls endpoint). Everything here applies to `/autoroute/v1/messages`; the hint headers are also read on `/autoroute/v1/chat/completions`.

### Detection

`GET /health` (no auth, even with `client_auth_key`) returns HTTP 200 and JSON:

```json
{"status":"ok","service":"octo","version":"0.1.0","capabilities":["autoroute","route_hints","result_headers","budget_key","route_api"]}
```

`route_api` means `POST /autoroute/v1/route` exists.

### Request headers (harness to router)

All are optional and stripped before the upstream request (upstream headers are an allowlist anyway). An invalid value is ignored and logged at `debug`; a bad hint never produces a 4xx.

| Header | Value | Effect |
| --- | --- | --- |
| `x-octo-budget-key` | printable ASCII, at most 128 chars (the project id) | Spend is tracked per key across every session that sends it, with or without `metadata.user_id` |
| `x-octo-budget-usd` | positive decimal, e.g. `0.50` | Budget for that key; ignored without a budget key. Latest value sent for a key wins |
| `x-octo-agent-role` | `orchestrator` or `sub` | `sub` (or any depth above 0) makes a new session start at `min(hint, classifier)` |
| `x-octo-agent-depth` | integer, `0`, `1`, ... | See above |
| `x-octo-tier-hint` | `fast`, `balanced`, `deep` (map to `low`, `mid`, `high`) | Starting tier of a new session (see below) |
| `x-octo-tier-policy` | `auto` (default), `ceiling`, `fixed` | How binding the hint is |
| `x-octo-task` | URL-encoded text, truncated to 200 characters | Prefixed to the classifier input as `Task: ...`; only used when the classifier runs |

**Tier hint semantics.** A "new session" is one with no remembered tier (first request, or after a compaction reset).

| Policy | New session | Later turns |
| --- | --- | --- |
| `auto` | Orchestrator or role absent: starts at the hint, no classifier call, trigger `hint`. Sub-agent: classifier runs, starts at `min(hint, classifier)` (trigger `classify` when the classifier is lower, `hint` otherwise; if the classifier fails or no API key is present, the hint) | Normal sticky, hysteresis, stall and budget rules; the hint is not re-applied |
| `ceiling` | Same start as `auto` | Same rules as `auto`, then the result is clamped to at most the hint tier on every turn. This includes stall escalation, `upgrade` to a larger-context ladder model, the unavailable-model retry escalation and a remembered higher session. A clamp reports trigger `hint` |
| `fixed` | The hint's ladder tier, trigger `hint`, no classifier call | Every turn is served at the hint's tier; stall escalation and classification are ignored; no fill upgrade above it |

Budget rules apply inside these bounds: a budget cap may still pick a cheaper tier than the hint (trigger `budget_cap`). Permission checks, housekeeping and background-model requests keep their own handling (housekeeping is always `low`, so it never exceeds a hint). Fixed and ceiling hints do not stop a context overflow from compacting.

### Budget

The effective budget for a budget key is the smaller of `x-octo-budget-usd` and `autoroute.session_budget_usd` (0 means the configured one is off, so the header alone applies). Spend accumulates per budget key from every call (reported cost first, then the price estimate) including compaction calls and classifier calls made with a session id.

**Spend survives a restart.** Every charge to a budget key is also added (off the request path) to the `budget_spend` table of the SQLite history database. The first request that names a key the process does not hold (after a restart, or after the key was idle for an hour and left memory) reads that key's persisted total once and seeds the in-memory ledger with it, so `x-octo-spent-usd` and budget rejection are correct from then on. Chosen over deriving spend from the call records because records are pruned by age and count while a project's spend must not shrink with them, and over a start-up scan because keys are unbounded and the in-memory ledger forgets idle keys anyway. Cost: one primary-key read on the first request per key per process. Spend of sessions without a budget key is unchanged: it is restored from the history `calls` and `decisions` rows of that session. Without a history database (`history disabled`) spend is in memory only, as before.

Action when spend reaches the budget:

- the budget came from the header (header is smaller than or equal to the configured budget, or the configured one is off): always **reject**, because the harness's project budget is a hard cap;
- the configured budget is the smaller one: `session_budget_action` applies (`downgrade` or `reject`).

Reject returns HTTP 402 before any upstream or classifier call, Anthropic-shaped:

```json
{"type":"error","error":{"type":"billing_error","message":"autoroute budget key `proj-9` budget exceeded: spent $2.000000 of $0.010000 (...)"}}
```

with result headers `x-octo-trigger: budget`, `x-octo-budget-usd`, `x-octo-spent-usd` and `x-octo-request-id`.

### Result headers (router to harness)

Set on the response head, so they are available before a streamed body starts. Sent on every Messages response that reaches the router's forward path, including compaction and 402 (which has no model or tier). Errors raised before a response exists (for example upstream connect failure, which becomes a plain 502 JSON error) carry none.

| Header | Value |
| --- | --- |
| `x-octo-model` | The model actually sent upstream (ladder slug after any retry escalation) |
| `x-octo-tier` | `low`, `mid`, `high` (`custom` for a client-preferred high model); the tier actually served |
| `x-octo-decided-tier` | Only when the [price rule](#price-rule-never-pay-more-for-less) served a different tier than the one decided: the decided tier |
| `x-octo-price-swap` | `1` exactly when `x-octo-decided-tier` is present |
| `x-octo-trigger` | Why: `none` (plain sticky turn), `classify`, `reclassify`, `tool_update`, `hint`, `budget_cap`, `budget` (402), `stall:*`, `stall_release`, `hysteresis_hold`, `housekeeping`, `housekeeping_trimmed`, `permission_check`, `upgrade`, `retry`, `classifier_failure`, `compact_not_applied`, `compact`, ... (same values as the history `trigger` column) |
| `x-octo-request-id` | Id of this call, key for the calls endpoint (`octo_<hex>`). With a retry, the id is the final attempt's |
| `x-octo-budget-usd`, `x-octo-spent-usd` | Effective budget and spend so far (USD, six decimals) for the budget key, or for the session when only the configured budget applies. Absent when no budget applies. Spend excludes the response being sent |

### `GET /autoroute/v1/calls/{request-id}`

```json
{"model":"deepseek/deepseek-v4.1-flash","tier":"low","trigger":"hint","input_tokens":1000,"output_tokens":500,"cache_read_tokens":0,"cache_write_tokens":0,"cost_usd":0.002,"cost_source":"estimated"}
```

- `decided_tier` is present only when the price rule served another tier than the one decided (then `tier` is the served one).
- 404 `{"error":"unknown or unfinished request",...}` until the response body has ended (the row is written when the stream finishes, before the client sees the end of the body), and for ids that were evicted or never existed.
- `cost_source` is `reported` when the cost came from the upstream (OpenRouter `usage.cost` or BYOK upstream cost) and `estimated` otherwise (`prices.toml`; when nothing is priced `cost_usd` is `0` and the source is `estimated`).
- Failed responses (non-2xx) and cancelled ones (client dropped the stream) get a row too, with the tokens known so far (estimated for dropped streams) and no cost when unknown.
- Storage: a read-through pair. The most recent 4096 calls are cached in memory and answered first; every finished call is also written (off the response path, after the stream ends) to the `autoroute_calls` table of the SQLite history database, and a miss in the cache is answered from there. Records therefore survive a restart. With the history database disabled or `sqlite::memory:` the persistence lasts as long as the process (memory) or is absent (disabled), and only the cache answers.
- A record is the JSON shown above (plus `route` for routing decisions). It holds no prompt text, and it is written whatever `history.store_payloads` says; the only free text in it is the `route.reason`, which the router builds from fixed phrases and the candidates' ids and labels.
- The history `calls` row of a proxied call has a `request_id` column with the same `octo_...` id, so the two can be joined. Route decisions and compactions are in `autoroute_calls` (compactions in `calls` too, with their id).
- Retention (`config/history.toml`): `calls_max_age_days` (30), `calls_max_rows` (100000), `budget_spend_max_age_days` (90, counted from the last charge), `0` disables a limit. A background pass every `prune_interval_secs` (600; `0` = never prune) deletes in batches of 500 with a pause between batches, so it holds the database's single writer only briefly and no request waits for it. The `calls` / `decisions` history tables are not pruned.
- What a crash loses: writes are queued after the response body ends. A process kill within a few milliseconds of a call finishing, or a burst that fills the 32-insert queue for more than 5 seconds (the existing history rule, counted in `dropped_inserts`), loses that call's record and its spend increment; a graceful shutdown drains them. The in-memory spend is not affected until the next restart.
- Cost per call also feeds the budget ledger above; the harness does not have to sum anything itself.

### Compaction

When the context passes the fill threshold (or the previous reply stopped with `model_context_window_exceeded`), autoroute does not forward the turn. It POSTs the request to OpenRouter Messages with `"compaction": {"type": "summarize"}`, `"stream": false`, the model's own ladder slug and the header `anthropic-beta: compact-2026-09-04`, and returns **the upstream's response unchanged** (status and JSON body; only the `content-type` is normalised to `application/json`). If the first model fails (non-2xx, unparsable, or `model_context_window_exceeded`) and a larger-context ladder model exists, the call is repeated once with that model.

How the harness detects and applies it:

1. Detect: response header `x-octo-trigger: compact` (the request was a compaction, not an answer). The body is an Anthropic Messages object, never a stream, whatever `stream` the client asked for.
2. Check success: HTTP 2xx and `stop_reason` equal to `"compaction"`. Anything else (non-2xx, `stop_reason: "model_context_window_exceeded"`) is a failed compaction: surface the error, do not replace history.
3. Read the summary from the `content` array: the block with `"type": "compaction"` and its `content` string (when none is present, concatenate the `text` blocks).
4. Apply: store the summary as the agent's compacted history and send a shorter history from the next request on (the raw messages may stay in the harness database). The compaction call's own `usage` and cost are in the calls endpoint (`trigger: compact`).
5. If the next request is not shorter than the compacted one, the router logs `compaction was not applied`, forwards normally with trigger `compact_not_applied` and will not compact that session again until its request falls below the fill threshold and rises again (or after `compact_cooldown_requests` requests).

Compaction only exists on `/autoroute/v1/messages`. On `/autoroute/v1/chat/completions` an overflow is forwarded as a normal chat call.

## Routing decision for delegation

Integration I2 of the same spec. Before the harness starts a sub-agent it asks the router which candidate should do the task. Candidates are API tiers and agents (for example ACP agents on a flat-rate subscription); an agent's traffic never passes through the router, so this endpoint is the only place the classifier can help it. The call makes **no upstream model call except one classifier (Decisions) call**.

`POST /autoroute/v1/route` — auth as for the other autoroute endpoints (`x-octo-key` when `client_auth_key` is set). The `Authorization` / `x-api-key` token is used for the classifier call, like on the proxy path.

```json
{
  "budget_key": "proj-9",
  "task": {"title": "Fix the flaky test", "brief": "...", "tools": ["Read", "Edit", "Bash"], "depth": 1},
  "candidates": [
    {"id": "api-fast", "kind": "api", "tier": "fast"},
    {"id": "api-deep", "kind": "api", "tier": "deep"},
    {"id": "claude-sub", "kind": "agent", "label": "Claude (subscription)", "flat_rate": true,
     "logged_in": true, "limit_remaining": 12, "strengths": ["medium", "hard"]}
  ]
}
```

```json
{
  "choice": "claude-sub",
  "band": "hard",
  "reason": "Hard task; Claude (subscription) (claude-sub) is flat-rate and logged in, so it adds no API cost.",
  "estimated_cost_usd": 0.0,
  "alternatives": [{"id": "api-deep", "estimated_cost_usd": 0.151}],
  "request_id": "octo_18c2..."
}
```

`model` is present only for an API choice: the ladder slug of the tier (`fast` = `autoroute.low`, `balanced` = `mid`, `deep` = `high`), after the [price rule](#price-rule-never-pay-more-for-less): the slug of the tier that would really be served. `request_id` is the key for `GET /autoroute/v1/calls/{id}`.

Request fields: `task.title` or `task.brief` must be non-empty; `task.tools`, `task.brief` and `task.depth` default to `[]`, `""` and `0`; `budget_key` follows the header rules (1 to 128 printable ASCII characters). `limit_remaining` may be omitted or `null` (unknown). Candidate `id`s must be non-empty and unique.

### Errors

| Status | When |
| --- | --- |
| 400 `invalid_request_error` | Body is not JSON of the shape above (unknown `kind` or `tier`, missing `task`, ...) |
| 422 `invalid_request_error` | Parses but cannot be served: empty `candidates`, duplicate or empty ids, bad `budget_key`, empty task, or no usable candidate (no API candidate and every agent logged out or at `limit_remaining` 0) |
| 402 `billing_error` | Budget reached, `reject` action in force and no usable flat-rate agent (same message as the proxy path) |

A failing classifier is never an error (see below). Errors are Anthropic-shaped (`{"type":"error","error":{...}}`).

### Classification

One JEV call on `title` + blank line + `brief` (capped to 2000 characters, head and tail kept, like the proxy path). `task.tools` are sent as the tool names; `depth` and `budget_key` are recorded on the call record. The result maps `Low`, `Mid`, `High` to the band `easy`, `medium`, `hard`; as on the proxy path, an `easy` verdict on a task that asks to inspect files or the repo while tools are available is raised to `medium`.

The call has its own timeout, `[autoroute.route].classifier_timeout_ms` (default 2000; `0` = never call it). When the classifier cannot run (no API key, timeout, connection or HTTP failure, unparsable answer) the band comes from a **deterministic text rule** and `reason` says `classifier not used: <why>` (`no API key`, `timed out`, `call failed`, `disabled`). The rule uses the facts `jev::inspect` already computes on the text:

1. If the offered candidates are only API candidates of one single tier (plus agents that are unusable), the band is that tier's band (nothing to decide).
2. Signals: the text mentions several files (the phrase, or two or more paths), mentions tests, or is longer than 1500 characters.
3. `hard` when the text mentions a stack trace / traceback / exception, or two or more signals hold. `easy` when no signal holds, the text is at most 280 characters and does not ask to inspect files or the repo. Otherwise `medium`.

Classifier spend (reported cost, else the price estimate) is added to the `budget_key`'s spend like any classifier call.

**Latency.** The decision is one classifier round trip plus in-memory work. Expect the latency of one Decisions call (typically a few hundred milliseconds to about a second; not measured against the real classifier here) when it runs, and well under 10 ms when it does not (no key, `0`, a reached budget, or after a timeout). The harness waits 300 ms by default, so against a real classifier it will often fall back on its own choice; raise the harness wait or lower `classifier_timeout_ms`, whichever fits. The router's worst case is `classifier_timeout_ms`.

### Choice policy

Band to tier: `easy` -> `fast`, `medium` -> `balanced`, `hard` -> `deep`.

| Rule | Behaviour |
| --- | --- |
| API candidate is *able* | its tier is the band's tier or higher |
| Agent candidate is *able* | it is usable and lists the band in `strengths`, or has no recognised `strengths` and the band is `easy` or `medium`; for `hard` an agent without `strengths` is able only when `prefer_flat_rate_for_hard = true` |
| Usable agent | `logged_in: true` and `limit_remaining` not `0` (or not above 0); an unusable agent is never chosen, not even as a last resort, and never listed as an alternative |
| Preference order among able candidates | 1. agents with `flat_rate: true` (most `limit_remaining` first, unknown counts as plenty); 2. API candidates by estimated cost (lowest first; unpriced after priced; then lower tier first); 3. agents with `flat_rate: false` (same limit order). Remaining ties by request order |
| Nothing able | the highest API tier offered (first on ties), else the first usable agent; `reason` says no candidate was rated for the task; `alternatives` is empty |
| Nothing usable | 422 |
| Budget reached | no classifier call (band from the text rule). A usable flat-rate agent is chosen (one able for the band if any, else the first by the order above), reason `Budget reached`. With none: if the budget's action is `reject` (always for a harness `x-octo-budget-usd`) 402; with `downgrade` the cheapest offered API tier (else the first usable agent) |

`strengths` vocabulary: `easy`, `medium`, `hard` (case-insensitive). Other words are ignored; a list with no recognised word counts as no `strengths`.

`estimated_cost_usd` is the blended cost of a nominal request through the price table, for the model the router would really serve for that candidate's tier (the candidate's own ladder model unless the price rule picks a cheaper tier above it): `nominal_input_tokens` in and `nominal_output_tokens` out (default 30000 / 500, the same shape budget routing uses). It is `null` for an API tier whose ladder model has no usable price (missing, partial or all-zero rates), `0` for a flat-rate agent and `null` for an agent that is not flat-rate. The estimate is of the delegated work only, not of the classifier call.

### Call record

The decision is stored as a call record (same read-through store as the proxy calls) and readable through `GET /autoroute/v1/calls/{request_id}`: `trigger: "route"`, `model` is the ladder slug (API choice) or the agent id, `tier` is the served `low`/`mid`/`high` or `agent` (`decided_tier` is added when the price rule swapped it), token counts and `cost_usd` are those of the classifier call (zero when it did not run), and an extra `route` object carries `choice`, `band`, `reason`, `classifier` (`used`, `fallback`, `skipped`), `depth` and `budget_key`. The classifier call is also written to the SQLite history as a decision row with purpose `route`.

### Config (`[autoroute.route]`, `config/autoroute.toml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `classifier_timeout_ms` | `2000` | Timeout of the classifier call; `0` disables it |
| `prefer_flat_rate_for_hard` | `false` | Let an agent without `strengths` take hard tasks |
| `nominal_input_tokens` | `30000` | Token assumption for API cost estimates |
| `nominal_output_tokens` | `500` | Token assumption for API cost estimates |

Tests: `tests/route_api.rs`.
