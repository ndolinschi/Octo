# Cost audit: router (apps/router) and harness (apps/harness)

Read-only audit, 2026-11-10. Paths are relative to /home/user/Octo/apps. "Confirmed" means I ran it; scripts and captures are in this directory
(rt/tests/cost.rs = router experiments A-G, cap/ = 45 captured harness request bodies, analyze.py = prefix/caching analysis).
Dollar figures use only repo numbers: router/config/prices.toml for the ladder, and the harness README example table
(opus: input 5, output 25, cache_read 0.5, cache_write 6.25 USD/1M) for harness examples. The 0.1x read / 1.25x write ratio comes from that example.

## 1. Verdict
The harness sends no prompt-caching markers and never compacts, so every loop iteration re-pays the whole history at full input price, and the
orchestrator runs on the most expensive model by default. Nothing in either system is a hard spend limit: the harness has no budget at all, and the
router's budget is off by default, only re-routes to "mid" when on, and is tracked per agent session. The router's own price table says the ladder
is inverted (high is the cheapest model, mid the dearest), so either routing or the cost numbers are wrong, and the table overrides OpenRouter's
reported cost.

## 2. Findings, ranked by expected money impact

| # | Where | What happens | Why it costs more | Estimated impact | Confidence | Smallest fix |
|---|---|---|---|---|---|---|
| 1 | harness/internal/agent/loop.go:46-58 | No `cache_control` on tools, system or messages | Each iteration bills the full prefix as fresh input | 25-iteration sub-agent growing 2k tok/iter: 625k input tok vs ~121k input-equivalents cached (-80%); $3.1 vs $0.6 per run at $5/M | Confirmed: 0 `cache_control` in 45 captured requests; message prefixes byte-stable, tools sorted | Mark the last tool, the system block and the last message block as cacheable |
| 2 | harness/internal/orchestrator/history.go:15, runtime.go:118 | Orchestrator thread reloaded in full every turn, never summarised (spec lists compaction as a follow-up) | Input grows with project age; cost per turn is quadratic overall | 100 user turns x 3 requests, +1k tok/request: 45M input tok, about $225 at $5/M; a 30k rolling cap is about $45 | Confirmed growth in capture (3.5 KB to 15.9 KB over 3 turns); dollar figure is a model | Summarise older turns once the thread passes a token threshold |
| 3 | router/config/prices.toml:42-59, autoroute.toml:4-6 | Table: low 0.051/0.567, mid 0.15/0.60, high 0.006/0.50 (in/out) | At 30k in / 500 out: low $0.0018, mid $0.0048, high $0.0004. If true, easy turns cost 4x and medium 11x the "high" model | 4-11x on every non-high turn, or (if 0.006 is a typo) high-tier spend under-recorded about 10x | Read from config; real prices not checked | Verify the three rows against OpenRouter; reorder ladder or fix the row |
| 4 | harness/internal/tools/cap.go:5, local/handlers.go:79, orchestrator/spawn.go:93 | Tool results and sub-agent reports capped only at 1 MiB; `read_file` has no range | One result can be ~262k tokens and is resent on every later iteration | $1.31 per request carrying it at $5/M, up to ~$31 over 24 further iterations; or a context-overflow failure after the spend | Read from code | Cap results near 30-50 KB, add offset/limit to `read_file`, cap reports |
| 5 | harness/internal/config/config.go:44-49 | Orchestrator and "deep" default to opus | The longest-lived, never-compacted thread runs on the dearest model, though its prompt says to only delegate | Model-price ratio on all of finding 2 | Confirmed in capture (9 of 45 requests opus orchestrator, 9 opus deep) | Default orchestrator to the balanced tier |
| 6 | router/src/auto/decide/mod.rs:320-347, route.rs finish_overflow | After the 75% fill threshold, every request becomes a full-context compaction call until the client's request halves | A client that does not apply compaction (the harness) pays full context per call and gets a summary, not an answer | One full-context call per request, indefinitely | Confirmed (experiment G: 4 of 4 requests turned into compaction) | Clear `awaiting_compact` after one compaction when the client did not shrink |
| 7 | router/src/auto/decide/mod.rs:432-458, classify.rs:51 | New session + classifier failure: request passes through with the client's model and is not remembered, so the whole tool loop does too | Bypasses the ladder; cost is whatever the client asked for | Client-model price for the session while the classifier is down | Confirmed (experiment A) | Fall back to mid and remember it |
| 8 | harness/internal/orchestrator/prompts.go:45-51 | Notes sit in the system prompt ahead of static text; `save_note` changes it | Once caching exists, each note change invalidates the whole history cache | With #1 fixed: a full-history cache rewrite per note change | Confirmed: system hash changed on each of 3 user turns | Move notes to the end of system, or into the latest user message |
| 9 | harness/internal/agent/loop.go:88-107, spawn.go:99 | At 25 iterations the agent returns only an error; no partial report | Up to 25 requests of work discarded; parent likely re-delegates | Up to 2x on tasks that hit the cap | Read from code | On the last iteration force a tool-free wrap-up |
| 10 | router/src/auto/body.rs:738-750 | Missing `max_tokens` is set to the model maximum | Raises the ceiling for runaway output | Client-dependent; harness always sends 8192 | Confirmed (experiment B: 128000) | Default to a fixed value such as 8192 |
| 11 | router/src/auto/decide/classify.rs:60 | Classifier gets the whole last user text, uncapped | Extra call per user-text turn scales with pasted content | 580 KB text gives a 602 KB classifier request; fixed overhead 1.8 KB | Confirmed (experiment F); classifier price unknown | Send `cap_decision_text` (2000 chars) |
| 12 | harness/internal/tools/local/local.go | Only `write_file` (whole file); no edit tool | Every edit re-emits the file as output tokens, the dearest kind | 20 KB file: ~5k output tok, $0.125 per edit at $25/M | Read from code | Add a string-replace edit tool |
| 13 | router/src/proxy/autoroute/mod.rs:212-271 plus Go SDK MaxRetries=2 | Router retries 429/5xx once on the next tier up, no backoff; SDK retries the whole thing twice | Up to 6 upstream attempts and 3 classifier calls per request | Bounded; only during incidents | Read from code; retry tests pass | Honour `retry-after`; retry same tier first |

## 3. Runaway-cost scenarios (unbounded)
- Harness has no token or dollar budget anywhere (no "budget" in non-test Go code). Limits are 25 iterations per agent per user message and depth 3
  (settable to 8); fan-out per message is unlimited and runs in parallel (loop.go:142, spawn.go).
- Router budget: off by default (`session_budget_usd = 0`). When on it never refuses a request; it only moves high to mid (experiments D, E: $500
  spent on a $1 budget still forwards). By the price table mid is the dearest model, so the cap raises the price.
- Budget is keyed per session id, and the harness uses the agent id (runtime.go:132), so each sub-agent gets a fresh budget (experiment E).
- Finding 6 (compaction loop) and finding 2 (orchestrator thread) have no upper bound.
- ACP sub-agents: no iteration cap, permissions auto-approved, no budget (acp_session.go).
- Stall escalation re-arms on every request while the pattern is in the 6-turn window, so the session stays on the top tier.

## 4. Accounting errors (cost shown differs from cost paid)
- Router prefers its price-table estimate over OpenRouter's reported cost (history/cost.rs:84-93). Experiment C: reported 12,300 micro-USD, recorded 1,650.
- Router estimate subtracts cache reads from `input_tokens` (cost.rs:125). Its own docs treat `input_tokens` as uncached, so uncached input is dropped:
  experiment C gives 1,650 where the table rates give 4,650. All `cache_write` rates are 0.
- Harness records usage only after a successful response (loop.go:66-78): failed and cancelled requests are billed upstream but never counted.
- Harness prices by requested model (loop.go:71), not the served one; through autoroute the two differ.
- Harness bills missing cache prices at the input rate (prices.go:42): cache reads overstated about 10x, cache writes understated about 20%, by the README example ratio.
- ACP rows record the growth of context used as input tokens (acp_session.go:89-98), not billed tokens.
- Router: a stream dropped mid-response is recorded without output tokens; history rows are dropped under insert backpressure; session spend lives
  in memory for 1 hour and is restored from the database only when a budget is set.

## 5. Already done well
- Harness: tools sorted by name, message history byte-stable across turns, small request overhead (system 0.7-1.5 KB, 5 tools 1.7 KB), `max_tokens` 8192,
  session id sent to the router, bash 30 s timeout, sub-agents start with a fresh context.
- Router: no model change inside a tool loop, two confirmations before stepping down, housekeeping turns forced to low and trimmed to 6 messages,
  permission checks skip the classifier, `anthropic-beta` headers are not forwarded (no long-context or other premium tier by header),
  `cache_control` passes through untouched, single retry only, classifier cost counted into session spend.

## 6. Not verified
- Real OpenRouter prices for the three ladder models and the classifier (needs the OpenRouter models API or an invoice).
- Whether the ladder providers cache automatically, their minimum cacheable length and TTL, and whether OpenRouter keeps provider affinity between
  requests with no provider pin (needs a real key and a 3-4 turn session, reading `cache_read_tokens`).
- How the harness SDK handles a compaction-shaped response (finding 6 end to end) and whether providers bill aborted streams.
- Harness test `internal/acp` has one failing test (`client_test.go:233`, broken pipe vs expected exit status); unrelated to cost.
