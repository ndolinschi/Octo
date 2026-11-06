# Octo autoroute verification — 2026-11-06

Branch: `main` @ `bf8808c`  
Zone for wall times: **Europe/Chisinau (UTC+2)**.  
No production code/config changed. Live smoke appended rows to `data/history.sqlite` only.  
Checklist A–F cross-checked against [Feature checklist evidence A-F](bc-eed6c010-fb7a-5f8a-9df1-e6745c07dbc7) (E4/E3/F3 tightened).

**Budget rule (this continuation):** ignore whole-DB history.  
`START_TS_MS=1793948576690` (= 2026-11-06 07:02:56 UTC / 09:02:56 Europe/Chisinau) = `created_at` of call id=220 (end of prior P1).  
Budget counts only `calls`+`decisions` with `created_at > START_TS_MS` (strict `>`). Call 220 **equals** START_TS, so prior work is **at/before** START_TS (excluded); only later rows count. Hard stop **$0.40**.

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
| C4 stall escalate/release | PASS | `stall_detects_*`, `stall_escalates_then_releases_*`, `decide_stall_escalates_*`; live P4 `stall:error_streak` mid→high |
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
| F1 calls cache/gen columns | PARTIAL | P3 fills `cache_read`+`cache_write` (integers); `generation_id` still `msg_*` (OpenRouter `gen-*` only in upstream **headers**, not body — see §7) |
| F2 decisions scores/cost | PASS | live id=74/93/94/100 scores+cost filled |
| F3 history burst drop | PARTIAL | slots=32, wait=5s, **drop** (no spill); **warn lacks `session_id`** (`history/mod.rs:139-142`, `200-204`) |
| STEP3 data today | PARTIAL | see §3; pre-restart leakage rows 72–73 (historical, before binary); post-restart P1–P4 clean |
| STEP4 live P1 | PASS | session `c436d4f2-…`, low, end_turn, $0.003451 |
| STEP4 live P2 | PASS | session `4907ca3c-…`, mid, end_turn, $0.005080 (client model must match mid or DeepSeek 400s on effort) |
| STEP4 live P3 | PASS | session `84f9c310-…`, high, end_turn, $0.080872; `cache_write` integers |
| STEP4 live P4 | PASS | session `140e671c-…`, `stall:error_streak` mid→high, $0.001673 |
| STEP5 OpenRouter recon | PARTIAL | `/v1/messages` returns `gen-*` in `x-generation-id` / `request-id` headers; body `id` is `msg_*`; Octo stores body id only |

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
**Live:**
- P1: `generation_id=msg_…`, `cache_read=0`, `cache_write=NULL`.
- P3 (Haiku): `cache_read` and `cache_write` are **integers** (not NULL) on every call; `generation_id` still `msg_*`.
- Direct OpenRouter `POST /api/v1/messages`: response header **`x-generation-id: gen-…`** (also **`request-id: gen-…`**); JSON/SSE body `id` remains Anthropic `msg_*`. Octo does not forward/store those headers.  
**Fix suggestion:** read `x-generation-id` (or `request-id`) from upstream response headers and prefer `gen-…` for `calls.generation_id`; keep `msg_` as fallback; add fixture test.

### F3 PARTIAL — dropped insert logging; no spill
**Where:** `src/history/mod.rs:32` (`INSERT_SLOTS=32`), timeout 5s, drop on wait timeout. Spill-to-disk **not implemented**.  
**Gap:** warn fields are `choice_rule` (decisions) or `kind`/`provider` (calls) — **no `session_id`**. No burst/timeout test.  
**Fix suggestion:** include `session_id` (and model/trigger) in both skip warn sites; optionally spill instead of drop if FinOps completeness matters.

### STEP3 data PARTIAL — housekeeping / reminder leakage (historical only)
**Rows:** decisions `id=72` starts with `<system-reminder>` (len 15504); `id=73` text begins `2-4 word lowercase label for this job.` (matches B1 pattern in `body.rs:36`).  
**Timing (Task 2):** id=73 `created_at=1793947969333` = **2026-11-06 06:52:49 UTC / 08:52:49 Europe/Chisinau** — **BEFORE** binary start **06:55:47 UTC / 08:55:47 Europe/Chisinau** (evidence: [`2026-11-06-binary-start.txt`](2026-11-06-binary-start.txt)).  
**Verdict:** keep as historical note; **do not mark B FAIL** (pre-restart binary). Live P1–P4 sessions: no housekeeping `decisions` rows; `user_text` equals the question (no system-reminder).  
**Fix suggestion:** none for code if only old binary; re-check if recurrence appears after current binary.

### Live compat note — mid tier + Claude Code effort (observed during P2)
Default Claude Code client (`claude-haiku-5-5`) remapped to `deepseek/deepseek-v4-flash` returns **HTTP 400** `Mid-conversation reasoning effort (configuration_update) is not supported…` when `output_config.effort` / adaptive thinking is present. Workarounds used for smoke only (not code changes): `--model deepseek/deepseek-v4-flash` and/or `CLAUDE_CODE_DISABLE_*THINKING`.  
**Fix suggestion (product):** strip or drop `output_config` / unsupported Anthropic effort fields when shaping onto non-Anthropic mid models (related to D2/D4).

### STEP5 PARTIAL — reconciliation id mismatch
Stored `generation_id` for messages is Anthropic-shaped `msg_*`, which OpenRouter `GET /api/v1/generation?id=` rejects. OpenRouter `gen-*` for `/v1/messages` lives in response headers (see §7). Historical chat.completions payloads embed `gen-*` in body `id` and reconcile (see §7).  
**Fix suggestion:** same as F1 — persist OpenRouter generation id from headers when available.

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
| A1 | strip via `body::question_text` → `strip_question_noise` (`body.rs:51-53`, `63+`; not `cap_decision_text`); JEV via `classify.rs:54-60` + `jev/questions.rs` | **Yes** — `question_text_strips_system_reminder_keeps_question`, `question_text_keeps_session_and_conversation_inner` |
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
| C4 | `stall.rs` + `sticky.rs:65-138`; trigger normalized to `stall:*` | detect + sticky + `decide_stall_escalates_without_catalog_or_jev`; **live P4** |
| C5 | `catalog.rs:75-92` | `high_pick_honours_preferred_only_when_allowlisted` |

### D. Compatibility shaping
Covered by `shape_strips_thinking_only_on_model_change_and_clamps_tokens`, tool forward tests, `anthropic_proxy_error_body_shape`, `messages_proxy_error_is_anthropic_shaped`.  
Live gap: mid DeepSeek still receives Claude Code `output_config.effort` → 400 (see §2 live compat note).

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
| F1 | columns in migration + insert; P3 proves `cache_write` can be a number; `generation_id` still body `msg_*` |
| F2 | `DecisionRow` scores/cost; live P1–P4 filled |
| F3 | 32 slots / 5s / drop; session_id not logged on drop |

---

## 5. Data checks (STEP 3) — `sqlite3 -readonly data/history.sqlite`

`created_at` is **unix ms**. “Today” = calendar **2026-11-06** UTC (= same date in Europe/Chisinau for these rows).

### Decision id=73 vs binary start (Task 2)
| Field | Value |
| --- | --- |
| id=73 created_at | 1793947969333 → 2026-11-06 **06:52:49 UTC / 08:52:49 Europe/Chisinau** |
| Binary start | 2026-11-06 **06:55:47 UTC / 08:55:47 Europe/Chisinau** (`target/debug/octo` pid **440725**) |
| Evidence | Live `ps`/`/proc` while process still running — [`2026-11-06-binary-start.txt`](2026-11-06-binary-start.txt): `ps … lstart` = `Fri Nov 6 06:55:47 2026`; `/proc` `btime+starttime_ticks` → epoch `1793948147` |
| Order | **BEFORE** start → historical only; B remains PASS on current binary |
| user_text start | `2-4 word lowercase label for this job.` — substring matches `is_housekeeping` (`body.rs:36`) |

### Live P2–P4 housekeeping / reminder check
No housekeeping pattern rows in decisions for primary sessions `4907ca3c…`, `84f9c310…`, `140e671c…`.  
Primary classify `user_text` equals the smoke question only (no `<system-reminder>`).

---

## 6. Live smoke (STEP 4)

**Proxy:** `target/debug/octo` pid 440725 (started 2026-11-06 **06:55:47 UTC / 08:55:47 Europe/Chisinau**; see [`2026-11-06-binary-start.txt`](2026-11-06-binary-start.txt)), `GET /health` → 200.  
**Client:** Claude Code 2.1.319, `ANTHROPIC_BASE_URL=http://127.0.0.1:8080/autoroute`.  
**Budget gate (new):** `START_TS_MS=1793948576690` (= call 220); count `created_at > START_TS_MS` only; hard stop **$0.40**.

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

### P2 mid — PASS
Prompt: chat/completions provider-selector question (RU). Read-only tools.

| Field | Value |
| --- | --- |
| session_id | `4907ca3c-105c-49de-bb0e-805b50c6660d` |
| decisions | id=93 purpose=classify complexity=**mid** hard=0.39 easy=0.20 cost_micros=37; user_text first 80 = question only (equals full question, len 175) |
| calls | 239 classify unset→mid deepseek cost=1547 cache_read=0 cache_write=NULL stop=tool_use; 240–242 none mid→mid …; 243 none mid→mid cost=1288 cache_read=22084 cache_write=NULL stop=**end_turn** |
| final answer | yes (explains `select` / unknown selector path from code) |
| session cost | **$0.005080** (calls $0.005043 + decision $0.000037) |
| housekeeping in decisions | none |

**Setup note:** first attempts with default Haiku client remapped to DeepSeek failed HTTP 400 (effort/`configuration_update`). Successful smoke used `--model deepseek/deepseek-v4-flash` + thinking disabled env vars (client-only).

### P3 high — PASS (+ cache fields)
Prompt: find bad autoroute upgrade scenarios (RU). Read-only tools.

| Field | Value |
| --- | --- |
| session_id | `84f9c310-cc1a-4317-a323-bdaa627a2b14` |
| decisions | id=94 purpose=classify complexity=**high** hard=0.81 easy=0.07 cost_micros=37; user_text equals question (len 193), no reminder |
| calls | 244 classify unset→high `~anthropic/claude-haiku-latest` … stop=tool_use; 245–251 none high→high …; 252 none high→high stop=**end_turn** |
| final answer | yes (scenarios + tradeoffs) |
| session cost | **$0.080872** |
| housekeeping in decisions | none |

#### P3 cache_read / cache_write per call (Task 3)

| call_id | cache_read_tokens | cache_write_tokens | cache_write NULL? |
| --- | ---: | ---: | --- |
| 244 | 0 | 24967 | **no** (integer) |
| 245 | 24967 | 2036 | no |
| 246 | 27003 | 12447 | no |
| 247 | 39450 | 11651 | no |
| 248 | 51101 | 19196 | no |
| 249 | 70297 | 6870 | no |
| 250 | 77167 | 14820 | no |
| 251 | 91987 | 7160 | no |
| 252 | 99147 | 13420 | no |

`generation_id` on all P3 calls: Anthropic-shaped `msg_*` (not OpenRouter `gen-*`).

### P4 stall — PASS
Prompt: loop on `python -c "import notexisting_module"` without installing / changing command. Stopped after ~10 tool turns on earlier attempts; successful session completed after 3 identical failing Bash runs + escalate.

| Field | Value |
| --- | --- |
| session_id | `140e671c-5b28-4867-854d-3664ac910983` |
| decisions | id=100 purpose=classify complexity=**mid** hard=0.34 easy=0.25 cost_micros=33; user_text equals question (len 135) |
| calls | 272 classify unset→mid deepseek stop=tool_use; 273–274 none mid→mid stop=tool_use; **275** `~anthropic/claude-haiku-latest` mid→high trigger=**`stall:error_streak`** cost=635 cache_read=0 cache_write=1994 stop=**end_turn** |
| final answer | yes (agent stopped: cannot fix under constraints) |
| session cost | **$0.001673** |
| housekeeping in decisions | none |

Earlier P4 attempts without stall (agent created files / wandered / gave up early) left extra mid sessions; ignored for pass criteria. Primary evidence is `140e671c…`.

---

## 7. Reconciliation / OpenRouter `gen-*` location (STEP 5 + Task 4)

### P1 stored `generation_id` (`msg_*`)
`GET https://openrouter.ai/api/v1/generation?id=msg_…` → **HTTP 400** `Invalid generation ID`. Cannot compare session cost to OpenRouter for P1 via stored column.

### Where OpenRouter returns `gen-*` for `/v1/messages` (do not implement)
Live direct `curl -D` to `https://openrouter.ai/api/v1/messages` (same key path as proxy). Full redacted header excerpt: [`2026-11-06-step5-headers.txt`](2026-11-06-step5-headers.txt).

| Location | Present? | Example / path |
| --- | --- | --- |
| Response header **`x-generation-id`** | **YES** | `x-generation-id: gen-1793949044-QBM9tgUyCLXvxY75L5u4` |
| Response header **`request-id`** | **YES** (same value) | `request-id: gen-1793949044-QBM9tgUyCLXvxY75L5u4` |
| Exposed via CORS | listed in `access-control-expose-headers: X-Generation-Id,…` | |
| JSON body `id` / SSE `message_start.message.id` | Anthropic **`msg_*` only** — no `gen-*` in body | |
| Octo→client headers for `/autoroute/v1/messages` | **does not forward** `x-generation-id` | client sees `content-type` / `date` only |
| Stored `calls.generation_id` | parser takes body/SSE `id` → `msg_*` | |

#### Header probe artifact (captured during verification; key redacted)
```
HTTP/2 200
content-type: application/json
access-control-expose-headers: X-Generation-Id, request-id
x-generation-id: gen-1793949044-QBM9tgUyCLXvxY75L5u4
request-id: gen-1793949044-QBM9tgUyCLXvxY75L5u4
```
Obtained via direct OpenRouter `POST /api/v1/messages` `curl -D` during the original verification run (gen id above is the one recorded then). This docs follow-up did **not** re-run the probe: `OPENROUTER_API_KEY` / `ANTHROPIC_AUTH_TOKEN` were unset in the agent shell and not present in the octo process environ; budget remains under the $0.40 cap.

Claude Code client error objects also surface `request_id: gen-…` (observed on P2 400 failures), confirming the upstream id is header/`request_id`-shaped.

### Chat completions / decisions body `id` (historical)
For OpenAI-shaped chat.completions, `gen-*` is in JSON body field **`id`** (and mirrored in stored `response_payload.payload.events[].id`). Decisions API uses body **`id`** like `gen-dec-…`.

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
| `START_TS_MS` | **1793948576690** |
| Spend after START_TS only (`calls`+`decisions`) | **0.105002** |
| Hard stop | 0.40 |
| Headroom remaining | ~0.295 |
| P1 session (at/before START_TS; prior task; excluded by `>`) | 0.003451 |
| P2 primary session | 0.005080 |
| P3 primary session | 0.080872 |
| P4 primary session | 0.001673 |
| Includes failed mid-compat probes / extra P4 attempts / tiny curl probes after START_TS | yes (in 0.105002) |

---

## 9. Remaining work (by impact)

1. **Persist OpenRouter `gen-*` from `x-generation-id` / `request-id` on `/v1/messages`** — unblocks STEP5 cost reconciliation and FinOps; largest accounting gap (F1/STEP5).
2. **Shape away Claude Code `output_config.effort` / unsupported thinking when routing to DeepSeek mid** — otherwise default Claude Code clients hard-fail on mid tier (live P2 400s).
3. **E4: apply session budget on fill-upgrade + retry; attribute compaction cost to session** — spend caps can be bypassed; FinOps undercounts compact.
4. **E2: unknown catalog window sentinel** — avoid repeated compact/fill on default 8192.
5. **C3 test for `tool_results_only: true`** — sticky hold currently untested in the true case.
6. **F3: log `session_id` on history drop; consider spill** — silent loss under burst.
7. **E3: refuse empty model seeds** — avoid forwarding `""`.
