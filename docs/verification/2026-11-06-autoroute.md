# Octo autoroute verification — 2026-11-06

Branch: `main` @ `bf8808c`  
Zone for wall times: **Europe/Chisinau (UTC+2)**.  
No production code/config changed. Live smoke appended rows to `data/history.sqlite` only.  
Checklist A–F cross-checked against [Feature checklist evidence A-F](bc-eed6c010-fb7a-5f8a-9df1-e6745c07dbc7) (E4/E3/F3 tightened).

---

## 1. Summary table

| Item | Status | Evidence (one line) |
| --- | --- | --- |
| STEP1 fmt | PASS | `cargo fmt --check` exit 0, empty stdout |
| STEP1 clippy | PASS | `cargo clippy -- -D warnings` exit 0, `Finished ... in 2.31s` |
| STEP1 tests | PASS | `cargo test` exit 0, **89** passed across integration crates |
| STEP1 git log | PASS | `bf8808c` merge tip; see §Static gates |
| STEP1 no `#[cfg(test)]` in `src/` | PASS | `rg '#\[cfg\(test\)\]' src/` → none |
| STEP1 unwrap/expect in `src/` | PASS | only `src/proxy/mod.rs:88` `.expect("install SIGTERM handler")` (startup signal) |
| A1 classifier strip | PASS | tests `question_text_strips_*` + live decision id=74 question-only |
| A2 mentions_* from stripped | PASS | `question_text_strips_system_reminder_keeps_question` asserts `!mentions_tests` |
| A3 empty after strip | PASS | `empty_question_after_strip_holds_current_model` → model `mid-m`, trigger `none` |
| B1 housekeeping patterns | PASS | `is_housekeeping` in `src/auto/body.rs:27-36`; asserts in `session_id_comes_*` / `housekeeping_fixture_*` |
| B2 housekeeping route | PASS | `housekeeping_forces_*`, `housekeeping_writes_no_decisions_row` (count=0) |
| C1 thresholds from config | PASS | `config/autoroute.toml` → `state.rs:63-64`; `threshold_parsing_picks_bands_from_noul_scores` |
| C2 hysteresis | PASS | `stall_escalates_then_releases_and_down_needs_confirm` (hold then down after 2); unset→hold edge untested (`band_rank("unset")`→1) |
| C3 tool_result-only hold | PARTIAL | code `sticky.rs:89-101` + `hold_without_classify`; **no test sets `tool_results_only: true`** |
| C4 stall escalate/release | PASS | `stall_detects_*`, `stall_escalates_then_releases_*`, `decide_stall_escalates_*` |
| C5 high_allow | PASS | `high_pick_honours_preferred_only_when_allowlisted` |
| D1 tools never filtered | PASS | `first_turn_forwards_all_tools_*`, `later_turn_forwards_all_tools`, shape keeps tools |
| D2 thinking strip on change | PASS | `shape_strips_thinking_only_on_model_change_and_clamps_tokens` |
| D3 max_tokens clamp | PASS | same test → `max_tokens == 4096` |
| D4 drop thinking param | PASS | same test → `changed.get("thinking").is_none()` |
| D5 Anthropic error shape | PASS | `anthropic_proxy_error_body_shape`, `messages_proxy_error_is_anthropic_shaped` |
| E1 retry before client bytes | PASS | `autoroute_retries_once_on_429_before_client_bytes` (2 upstream bodies); 5xx/connect retry **code only** |
| E2 unknown window | PARTIAL | missing catalog → `context_length` defaults **8192** (`catalog.rs:150-154`); can still compact; no dedicated “no upgrade every turn” test |
| E3 empty model never sent | PARTIAL | `Tiers::pick` returns config slugs; cost-seed can create `SessionChoice::fresh("")` (`decide/mod.rs:104-106`) — **code only** |
| E4 budget + compaction cost | PARTIAL | decide-path `cap_for_budget` tested; fill-upgrade / retry skip budget; compact `record` never `add_session_cost` (`compact.rs:123-166`) |
| F1 calls cache/gen columns | PARTIAL | schema+parser+tests; live P1 fills `generation_id`/`cache_read=0`; `cache_write` NULL when upstream omits; stores `msg_*` not OpenRouter `gen-*` |
| F2 decisions scores/cost | PASS | live id=74 `is_hard_score=0.07` `is_easy_score=0.86` `cost_micros=35`; `threshold_parsing_*` |
| F3 history burst drop | PARTIAL | slots=32, wait=5s, **drop** (no spill); **warn lacks `session_id`** (`history/mod.rs:139-142`, `200-204`) |
| STEP3 data today | PARTIAL | see §3; pre-fix leakage rows 72–73; post-fix P1 clean |
| STEP4 live P1 | PASS | session `c436d4f2-…`, low, end_turn, $0.003451 |
| STEP4 live P2–P4 | NOT IMPLEMENTED | skipped: DB `calls+decisions` already **$0.483880** after P1; headroom **$0.01612** < safe P2–P4 estimate |
| STEP5 OpenRouter recon | PARTIAL | historical `gen-*` match within $0.001; P1 `msg_*` → API 400 Invalid generation ID |

---

## 2. Failures and partials (fix suggestions — not applied)

### C3 PARTIAL — tool_result-only keep model
**Where:** `src/auto/decide/sticky.rs:89-101`, `src/auto/decide/mod.rs:401-402`.  
**Gap:** every sticky test passes `tool_results_only: false`.  
**Fix suggestion:** add an integration test that seeds a sticky mid session, sends a user message whose content is only `tool_result` blocks, asserts forwarded model unchanged and no JEV/`decisions` row.

### E2 PARTIAL — unknown context window
**Where:** `src/auto/catalog.rs:150-154` defaults missing windows to `8192`.  
**Risk:** with catalog fetch failed, large turns can hit `usable < 1024` / fill paths and compact repeatedly even though `larger_fit` will not upgrade equal 8192 windows.  
**Fix suggestion:** treat unknown window as “do not upgrade / do not compact for fill” (e.g. return a sentinel or skip fill/compact when `lookup` misses), and lock with a test where `models: None` and a large body stays on the sticky model without compact.

### E3 PARTIAL — empty model string
**Where:** `src/auto/catalog.rs:71-86` `pick` returns config strings with no `is_empty` check.  
**Also:** `add_session_cost` / `sync_session_cost_floor` seed `SessionChoice::fresh(String::new(), …, "unset")` (`src/auto/decide/mod.rs:104-106`, `119-121`); a later hold could forward `""`.  
**Fix suggestion:** refuse empty tier slugs at config load; never seed empty model; assert non-empty before `with_model`.

### E4 PARTIAL — budget on upgrade/retry; compaction session cost
**Where:**
- Decide applies `cap_for_budget` before route (`sticky.rs:158-173`; tests `session_budget_cap_clamps_high_to_mid`).
- Fill upgrade inside `route::run` changes model without re-checking budget (`src/auto/decide/route.rs:114-130`).
- Upstream retry `next_up` has no budget check (`src/proxy/autoroute/mod.rs:133-161`).
- Compaction history `record` sets `session_id: None` and never calls `auto.add_session_cost` (`src/proxy/autoroute/compact.rs:123-166`); normal stream path does add cost (`providers/utils.rs:199-203`).  
**Fix suggestion:** re-run `cap_for_budget` after fill-upgrade and before retry; pass session into compact observe and `add_session_cost` from compact usage; add tests for each.

### F1 PARTIAL — cache/generation fill
**Where:** parser `src/history/payload/common.rs:153-200`; insert `src/history/mod.rs:445-483`.  
**Live:** P1 calls 218–220 have `generation_id=msg_…`, `cache_read_tokens=0`, `cache_write_tokens=NULL`. OpenRouter generation API rejects `msg_*` (HTTP 400).  
**Historical today (pre-restart binary):** calls 216–217 all cache/gen NULL.  
**Fix suggestion:** prefer OpenRouter `gen-…` id when present in the stream/headers; keep Anthropic `msg_` as fallback; backfill tests with a fixture that includes both.

### F3 PARTIAL — dropped insert logging; no spill
**Where:** `src/history/mod.rs:32` (`INSERT_SLOTS=32`), timeout 5s, drop on wait timeout. Spill-to-disk **not implemented**.  
**Gap:** warn fields are `choice_rule` (decisions) or `kind`/`provider` (calls) — **no `session_id`**. No burst/timeout test.  
**Fix suggestion:** include `session_id` (and model/trigger) in both skip warn sites; optionally spill instead of drop if FinOps completeness matters.

### STEP3 data PARTIAL — housekeeping / reminder leakage (historical)
**Rows:** decisions `id=72` starts with `<system-reminder>` (len 15504); `id=73` matches B1 “2-4 word lowercase label…”.  
**Times:** 2026-11-06 08:52 Europe/Chisinau — **before** running binary restart 08:55 Europe/Chisinau (`target/debug/octo` mtime).  
**Fix suggestion:** none for code if only old binary; re-check after more live traffic. If recurrence on current binary, ensure title/label prompts hit `is_housekeeping(&raw_text)` before classify.

### STEP4 P2–P4 NOT IMPLEMENTED — budget stop
Combined `calls.cost_micros + decisions.cost_micros` was **$0.480429** before live, **$0.483880** after P1. Rule: stop if table total exceeds **$0.50**. Remaining headroom **$0.01612**; P2–P4 estimated well above that.  
**Fix suggestion for future verification:** use an isolated temp history DB for smoke, or raise the verification budget / clear non-essential historical costs offline.

### STEP5 PARTIAL — reconciliation id mismatch
Stored `generation_id` for messages is Anthropic-shaped `msg_*`, which OpenRouter `GET /api/v1/generation?id=` rejects. Historical payloads embedding `gen-…` reconcile (see §5).  
**Fix suggestion:** same as F1 — persist OpenRouter generation id when available.

---

## 3. Static gates (STEP 1)

### `cargo fmt --check`
```
EXIT:0
(empty stdout)
```

### `cargo clippy -- -D warnings` (tail)
```
    Checking octo v0.1.0 (/workspace)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.31s
EXIT:0
```

### `cargo test` (summary)
```
tests/autoroute.rs          28 passed
tests/autoroute_retry.rs     2 passed
tests/chat_provider_select   7 passed
tests/history_payload.rs    12 passed
tests/history_session_cost   1 passed
tests/history_store.rs       6 passed
tests/openai_headers.rs      1 passed
tests/openrouter_headers.rs  4 passed
tests/openrouter_models.rs   3 passed
tests/provider_wire.rs       5 passed
tests/proxy_post.rs          5 passed
tests/route_integration.rs   6 passed
tests/select_provider.rs     9 passed
lib/main/doc                 0 tests
TOTAL                        89 passed, 0 failed
EXIT:0
```

### `git log --oneline -15`
```
bf8808c Merge branch 'cursor/classifier-housekeeping-cache-a705'
577ea48 Fix history drain race and cover housekeeping fill skip.
c4a6307 Treat integer usage.cost as USD dollars, not micros.
df7859a Fix housekeeping: before compact, skip fill-upgrade, add strip tests.
872a313 Strip classifier input, force housekeeping to low, record cache usage.
bb22374 Fix review findings: stall on housekeeping, budget on hold path, DB spend floor.
df13476 Add autoroute housekeeping skip, session budget, and routing columns.
cd189f5 Fix stall-escalate review: honor up-tier during escalate, reshape retries.
986366e Add Claude Code-compatible stall escalation for autoroute.
780865a Force compaction non-stream and reuse OpenRouter auth helpers.
f2dd41c Address keep-client-tools review: move parse tests, harden tool forward path, fix calibrate, tighten context heuristics.
e1bc43b Enrich Jev classify state and pick tiers from noul scores.
1880282 Keep every client tool on the autoroute path.
3d6a076 Merge pull request #7 from ndolinschi/cursor/jev-autorouting-a705
6c26418 Format autoroute sources for CI rustfmt check.
```

### `#[cfg(test)]` / unwrap
- `#[cfg(test)]` under `src/`: **none**
- `.unwrap()` / `.expect()` under `src/`: **`src/proxy/mod.rs:88`** only (`SIGTERM` install)

---

## 4. Feature checklist detail (STEP 2)

### A. Classifier input
| ID | Impl | Test asserts behaviour? |
| --- | --- | --- |
| A1 | `body::question_text` `src/auto/body.rs:51-65`; JEV state via `classify.rs:54-60` + `jev/questions.rs` | **Yes** — `question_text_strips_system_reminder_keeps_question`, `question_text_keeps_session_and_conversation_inner` |
| A2 | `jev::inspect(..., user_text)` `context.rs:33-37` with stripped text | **Yes** for `mentions_tests` (reminder says “Mention tests often” → false). `mentions_stack_trace` / `mentions_multiple_files` asserted in `jev_payload_includes_enriched_state` on already-clean text |
| A3 | `decide/mod.rs:291-305`, `hold_without_classify` | **Yes** — `empty_question_after_strip_holds_current_model` |

### B. Housekeeping
| ID | Impl | Test |
| --- | --- | --- |
| B1 | `body.rs:27-36` contains all five required substrings (+ extras) | `session_id_comes_from_metadata_user_id`, `housekeeping_fixture_title_session` |
| B2 | early return `decide/mod.rs:186-213` `persist:false`, `RouteMeta::housekeeping`, skip fill upgrade `route.rs:103-112` | `housekeeping_forces_low_without_touching_sticky`, `housekeeping_forces_low_even_when_stall_present`, `housekeeping_writes_no_decisions_row`, `housekeeping_skips_fill_upgrade_keeps_low`, `housekeeping_bypasses_awaiting_compact` |

### C. Tier decision
| ID | Impl | Test |
| --- | --- | --- |
| C1 | `config/autoroute.toml` hard/easy=0.5 → `state.rs:63-64` → `classify.rs:66-67` | `threshold_parsing_picks_bands_from_noul_scores` (incl. raised hard 0.7) |
| C2 | `sticky.rs:38-55`; unset starts as classified band | `stall_escalates_then_releases_and_down_needs_confirm` |
| C3 | see PARTIAL above | missing true-case test |
| C4 | `stall.rs` + `sticky.rs:65-138`; trigger normalized to `stall:*` | detect + sticky + `decide_stall_escalates_without_catalog_or_jev` |
| C5 | `catalog.rs:75-92` | `high_pick_honours_preferred_only_when_allowlisted` |

### D. Compatibility shaping
Covered by `shape_strips_thinking_only_on_model_change_and_clamps_tokens`, tool forward tests, `anthropic_proxy_error_body_shape`, `messages_proxy_error_is_anthropic_shaped`.

### E. Reliability
| ID | Notes |
| --- | --- |
| E1 | `proxy/autoroute/mod.rs:92-122` retries on status before returning response to client; 429 tested; 5xx/connect same gates, untested |
| E2 | PARTIAL — default 8192 |
| E3 | PARTIAL — empty seed via cost floor possible |
| E4 | PARTIAL — decide budget OK; fill-upgrade/retry uncapped; compact omits session cost |

### F. Accounting
| ID | Notes |
| --- | --- |
| F1 | columns in migration + insert; tests `usage_reads_anthropic_cache_and_generation_id`, `usage_reads_openai_cached_tokens_and_id`; live PARTIAL fill |
| F2 | `DecisionRow` scores/cost; live id=74 filled |
| F3 | 32 slots / 5s / drop; session_id not logged on drop |

---

## 5. Data checks (STEP 3) — `sqlite3 -readonly data/history.sqlite`

`created_at` is **unix ms**. “Today” = calendar **2026-11-06** UTC (= same date in Europe/Chisinau for these rows).

### 1) Today's calls by model
| model | n | cost_usd | input_tok | cache_read | cache_write | output_tok |
| --- | --- | --- | --- | --- | --- | --- |
| google/gemma-4-26b-a4b-it | 5 | 0.005410 | 72925 | 0 | 0 | 287 |

### 2) Share of today's `kind=messages` with NULLs
| messages_today | null_session | null_tier_after | null_cache_read | null_cache_write | null_generation_id |
| --- | --- | --- | --- | --- | --- |
| 5 | 0 | 0 | 2 | 5 | 2 |

(NULLs are the two pre-restart calls 216–217; P1 calls 218–220 have `cache_read=0`, `generation_id` set, `cache_write` still NULL.)

### 3) Today's `decisions.user_text` length
| n | min | median | max | starts_with `<system-reminder>` |
| --- | --- | --- | --- | --- |
| 3 | 95 | 393 | 15504 | 1 (id=72, historical) |

Live P1 id=74 len=95, no reminder.

### 4) Housekeeping leakage in decisions (B1 patterns)
| id | session_id | preview |
| --- | --- | --- |
| 73 | 3bc70582-aad4-4149-89c9-1ec0cbf19762 | `2-4 word lowercase label for this job.` … |

No leakage for P1 session.

### 5) Sessions whose last main-agent call `stop_reason != end_turn`
| session_id | last_call (Europe/Chisinau) | model | trigger | stop_reason |
| --- | --- | --- | --- | --- |
| 6f7b3497-f2b4-4db1-aead-f07012dfd290 | 2026-11-05 13:51:23 | ~anthropic/claude-haiku-latest | none | (missing in capture) |
| f2019979-1e00-4f60-b8de-7458844b2438 | 2026-11-05 13:45:31 | google/gemma-4-26b-a4b-it | reclassify | (missing in capture) |

P1 session last call **end_turn**.

### 6) Today's trigger distribution
| trigger | n | cost_usd |
| --- | --- | --- |
| none | 2 | 0.002297 |
| classify | 2 | 0.003101 |
| reclassify | 1 | 0.000012 |

No `housekeeping` / `stall:*` / `budget_cap` / `upgrade` / `retry` / `hysteresis_hold` in today's calls.

---

## 6. Live smoke (STEP 4)

**Proxy:** already running `target/debug/octo` (started 2026-11-06 08:55:47 Europe/Chisinau), `GET /health` → 200.  
**Client:** Claude Code 2.1.319, `ANTHROPIC_BASE_URL=http://127.0.0.1:8080/autoroute`, allowed tools `Read,Glob,Grep`.  
**Budget gate:** table total before P1 **$0.480429**; estimate P1 **~$0.005**; after P1 **$0.483880**; **stopped** (headroom $0.01612).

### P1 — expect low — PASS
Prompt: liveness endpoint question (RU).

| Field | Value |
| --- | --- |
| session_id | `c436d4f2-1107-4169-9f15-6013084ff547` |
| decisions | id=74 purpose=classify complexity=**low** hard=0.07 easy=0.86 cost_micros=35; user_text first 80 = question only (equals full question, len 95) |
| calls | 218 classify unset→low gemma cost=1119 cache_read=0 gen=`msg_U3Gp6yPmh22CExAQMnBf` stop=tool_use; 219 none low→low …; 220 none low→low … stop=**end_turn** |
| final answer | yes (`GET /health` in stdout) |
| session cost | **$0.003451** |
| housekeeping in decisions | none |

### P2 mid — NOT RUN
### P3 high — NOT RUN
### P4 stall — NOT RUN

Reason: would risk exceeding **$0.50** combined table spend required by the verification rules.

---

## 7. Reconciliation (STEP 5)

### P1 stored `generation_id` (`msg_*`)
`GET https://openrouter.ai/api/v1/generation?id=msg_…` → **HTTP 400** `Invalid generation ID` for all three P1 ids. Cannot compare session cost to OpenRouter for P1 via stored column.

### Historical payloads containing OpenRouter `gen-*` (embedded in output, not in `generation_id` column)

| call_id | session_id | sqlite cost_usd | OpenRouter total_cost | abs diff |
| --- | --- | --- | --- | --- |
| 7 | NULL | 0.000003 | 0.00000346 | 0.00000046 |
| 5 | NULL | 0.000085 | 0.0000845 | 0.0000005 |
| 3 | NULL | 0.000003 | 0.0000028 | 0.0000002 |

**Sessions with difference > $0.001:** none among reconciled rows (all had `session_id` NULL).

---

## 8. Total spend of this verification

| Scope | USD |
| --- | --- |
| Live smoke this task (P1 session only) | **0.003451** |
| OpenRouter generation metadata GETs | 0 (no billable generation) |
| `calls`+`decisions` table total after verification | **0.483880** |
| Verification live budget used vs $0.30 cap | 0.003451 / 0.30 |
| Table total vs $0.50 hard stop | 0.483880 / 0.50 (P2–P4 aborted) |
