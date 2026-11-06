# Orchestration routing — investigation (2026-11-06)

Read-only facts for Claude Code subagent orchestration via Octo autoroute.  
Zone for wall times: **Europe/Chisinau (UTC+2)**.  
Live probe budget: rows with `created_at > START_TS_MS` only; hard stop **$0.30**.

**START_TS_MS:** `1793949796472`  
(`SELECT max(created_at) FROM calls` immediately before A5.)

---

## A1. How Claude Code subagents look on the wire

### A1.1 Detection today

| Mechanism | Location | Behaviour |
| --- | --- | --- |
| `is_subagent` | [`src/history/payload/claude.rs:5-14`](../../src/history/payload/claude.rs) | Scans `system` text lines for `x-anthropic-billing-header:` then `;`-split token `cc_is_subagent=true` |
| Wrapper / re-export | [`src/providers/llm/claude.rs:20-22`](../../src/providers/llm/claude.rs) wraps history predicate; [`src/providers/llm/mod.rs`](../../src/providers/llm/mod.rs) `pub use` | Same predicate used by autoroute body helpers |
| `session_id` | [`src/auto/body.rs:8-16`](../../src/auto/body.rs) | `metadata.user_id` JSON → `session_id` string |
| `session_key` | [`src/auto/body.rs:18-25`](../../src/auto/body.rs) | Subagent → `{session_id}#subagent`; else bare id |

Autoroute stores `session_key(...)` as history `session_id` ([`src/proxy/autoroute/mod.rs`](../../src/proxy/autoroute/mod.rs) observe path).

### A1.2 Shared session_id across subagents

**SQL (historical, before START_TS):**

```sql
SELECT COUNT(*) FROM calls WHERE kind='messages' AND session_id LIKE '%#subagent%';
-- result: 0
-- (older rows often stored session_id NULL even when payload had cc_is_subagent)
```

Rust-accurate billing flag in `request_payload` (parse system header, not bare string): **12** historical messages calls across **2** parent UUIDs (`ebf019ca-…`, `a4230d2e-…`). Parent and subagent requests share the **same** `metadata.user_id.session_id`; Octo collapses all of them to **one** sticky key `{uuid}#subagent`.

**Live A5 confirmation (after START_TS):**

| Stored `session_id` | calls | payload `cc_is_subagent` |
| --- | ---: | --- |
| `5f362d28-1548-4c77-b3af-a5ff00ed5306` | 7 | false (main) |
| `5f362d28-1548-4c77-b3af-a5ff00ed5306#subagent` | 17 | true (all three Explore agents mixed) |

No per-agent discriminator in Octo’s key. Distinguishing fields available on the wire but **not** used for routing:

- Agent `tool_result` text includes launch metadata / `agentId` (see A1.4)
- First user `prompt` text differs per Agent invocation (decisions 102–105 show distinct first-task texts under the **same** `#subagent` key)

### A1.3 Agent tool definition (from history `request_payload`)

Observed on call id **12** (and consistently across Claude Code traffic):

| Field | Value |
| --- | --- |
| `name` | `Agent` |
| `required` | `["description","prompt"]` |
| `input_schema.properties` | `description`, `prompt`, `subagent_type`, `model`, `effort`, `isolation` (+ sometimes `run_in_background`) |
| `subagent_type` | `type: string` — **no enum** in schema (description only). Live A5 used `Explore`. |
| `model` | enum `sonnet`, `opus`, `haiku`, `fable` (optional override) |
| `effort` | enum `low`, `medium`, `high`, `xhigh`, `max` |
| `isolation` | enum `worktree`, `remote` |

Schema variant counts (earlier scan of tools[] containing Agent):  
165 with `effort`+no `run_in_background`; 43 with both; 4 without `effort`.

### A1.4 What the main agent receives after a subagent finishes

Immediate `tool_result` after Agent launch (A5 call **292**, JSON size ~1175 bytes each):

```text
type: tool_result
tool_use_id: call_…
content[0].text: "Async agent launched successfully. (This tool result is internal metadata — never quote…"
```

Final synthesis uses later user turns that embed subagent outputs (not measured as separate Octo “summary” messages). Historical call **64** showed a similar ~1KB launch ack mentioning `agentId` / task output path.

---

## A2. Cost structure of a subagent

### A2.1 First request (startup)

**Historical (gemma, id 73, billing-accurate subagent):**

| metric | value |
| --- | --- |
| model | `google/gemma-4-26b-a4b-it` |
| `request_bytes` | 126996 |
| `input_tokens` | 33379 |
| `cache_read_tokens` / `cache_write_tokens` | NULL / NULL |
| `cost_micros` | 2052 (**$0.002052**) |

**Live A5 first `#subagent` call (id 278):**

| metric | value |
| --- | --- |
| model | `deepseek/deepseek-v4-flash` |
| `request_bytes` | 25371 |
| `input_tokens` | 6282 |
| `cache_read_tokens` | **0** |
| `cost_micros` | 360 (**$0.000360**) |

Haiku historical “first” rows often show `input_tokens=2` with 70k+ `request_bytes` — **usage parse unreliable**; prefer `request_bytes` + `cost_micros`.

### A2.2 Typical length / overhead

| cohort | sessions | avg calls | avg total $ |
| --- | ---: | ---: | ---: |
| Historical accurate flag (2 sessions) | 2 | 6.0 | ~$0.013 |
| Live A5 shared `#subagent` key | 1 key / 3 logical agents | 17 calls | **$0.016348** |

Startup share (A5): first call $0.000360 / $0.016348 ≈ **2.2%** of subagent-key spend (DeepSeek mid, warm later cache_read up to ~20k). Historical gemma first call ~$0.002 was a larger fraction of a smaller session.

### A2.3 Cache share by model (subagent)

**Historical accurate-flag subagent rows (n=12):** cache_read/write all NULL → share **not measurable**.

**Live A5 `#subagent` (DeepSeek only, n=17):**

| | sum | notes |
| --- | ---: | --- |
| `input_tokens` | 59938 | |
| `cache_read_tokens` | 166272 | many turns with large cache_read |
| `cache_write_tokens` | all NULL | provider omitted / not parsed |
| model mix | 17× DeepSeek mid | no Gemma/Haiku subagent calls in A5 |

Cannot yet compare Gemma vs DeepSeek vs Haiku cache on subagents from one controlled matrix — **how to measure:** force three subagent probes with `CLAUDE_CODE_SUBAGENT_MODEL` / Agent `model` override and SELECT sum(cache_*) GROUP BY model WHERE session_id LIKE '%#sub%'.

---

## A3. Where the money goes in hard sessions

Sessions (2026-11-05, model `~anthropic/claude-haiku-latest`), classification rule:

> **simple_readonly** = this call’s response SSE only starts `tool_use` blocks whose names ∈ `{Read, Grep, Glob, SemanticSearch, WebFetch, NotebookRead}`; else **hard**.

| session_id | calls | total $ | simple $ | simple % | note |
| --- | ---: | ---: | ---: | ---: | --- |
| `726333aa-6e8d-4266-a49f-602bb65fab56` | 15 | 0.097581 | 0.019272 | 19.7% | Read+Bash mix |
| `6f7b3497-f2b4-4db1-aead-f07012dfd290` | 18 | 0.128333 | 0.016450 | 12.8% | |
| `a1892b80-c7e0-4a33-a730-fe8c66b3b57d` | 17 | 0.033116 | 0.003165 | 9.6% | |
| `ee7c460c-50bc-46b0-bf42-ed16f59061f1` | 14 | 0.027384 | 0.020499 | **74.9%** | Read-heavy |
| `8dcf5110-69f9-474c-aa74-d1297ca877dd` | 11 | 0.054011 | 0.000000 | **0%** | Bash-only |

**Context growth / cache_read trend:** not measurable on these rows (`cache_read_tokens` NULL; many `input_tokens=2` despite large bodies). **How to measure:** re-run similar tasks after cache columns fill reliably; plot `cache_read_tokens` and `request_bytes` by call ordinal.

**Agent usage on these five:** `Agent` `tool_use` count in request histories = **0**. Orchestration must nudge; current high-tier traffic does not self-delegate.

### Upper-bound saving formula

\[
save_{ub} = C_{simple} - N_{sub}\cdot S_{startup} - C_{low\_work} - C_{main\_summary}
\]

Assumptions for optimistic bound (stated explicitly):

- `C_simple` = sum of `cost_micros` on simple_readonly turns (table above)
- `S_startup` ≈ **$0.00205** (historical gemma first) or **$0.00036** (A5 DeepSeek first) — use the higher for conservatism when unknown
- `C_low_work` + `C_main_summary` **not measured** → set to 0 for upper bound only
- `N_sub` = number of distinct delegated parts (unknown historically; A5 used 3)

Optimistic (`C_low=0`, `S=$0.002`, `N_sub=1`): save ≤ **$0–$0.018** per session on this set.  
If `N_sub=3` and `S=$0.002`, ee7c460c upper bound falls to ≈ $0.0205 − $0.006 = **$0.0145**.  
Bash-heavy sessions: **$0**.

---

## A4. Router internals relevant to orchestration

### A4.1 Third JEV question

Payload built in [`src/auto/jev/questions.rs:13-33`](../../src/auto/jev/questions.rs) — add `needs_orchestration` beside `is_hard` / `is_easy` / `tools_enough`.  
Parse in [`src/auto/jev/parse.rs:28-47`](../../src/auto/jev/parse.rs) (`noul_score` / `Classified` in [`types.rs:4-15`](../../src/auto/jev/types.rs)); persist via [`src/auto/decide/classify.rs`](../../src/auto/decide/classify.rs) + migration.

State fields already sent: `user_text`, tools, `recent_errors`, `turn_index`, `current_tier`, `files_touched`, `mentions_*`.

### A4.2 Session keying / what breaks

`decide` actor = `body::session_key` ([`src/auto/decide/mod.rs`](../../src/auto/decide/mod.rs)). All concurrent subagents share `{id}#subagent` → **one** `SessionChoice`: shared sticky band, stall counters, escalate_remaining, session budget. Live A5: three Explore agents → single mid sticky, 17 interleaved calls.

### A4.3 System-prompt nudge site

[`src/auto/body.rs:286-297`](../../src/auto/body.rs) `shape` currently: model swap, thinking strip on change, max_tokens clamp, drop unsupported `thinking`.  
Safe injection point: append a **byte-stable** suffix to `system` (string or last text part) inside shape or a dedicated helper called only when orchestrate conditions hold.

**Cache effect:** Anthropic/OpenRouter prompt cache keys on prefix including `system`. Any nudge change invalidates the cached prefix for that session onward until the suffix is held constant. Keep the nudge text identical across turns when enabled.

---

## A5. Live probe (≤ $0.30 after START_TS)

| | |
| --- | --- |
| Prompt | Multi-part RU read-only: describe `src/auto/decide`, `src/history`, `src/proxy/autoroute` via subagents |
| Base URL | `http://127.0.0.1:8080/autoroute` |
| Allowed tools | `Read,Glob,Grep,Agent` |
| START_TS_MS | `1793949796472` |
| Spend after START_TS | **$0.025791** (calls+decisions) |

### Results

| Question | Answer |
| --- | --- |
| Did the model call Agent? | **Yes** — three `Agent` tool_use with `subagent_type=Explore` (call 277+) |
| How many subagents? | **3** logical; **1** Octo key `…#subagent` (collision) |
| Main session | `5f362d28-1548-4c77-b3af-a5ff00ed5306` — classified **mid** (not high); DeepSeek |
| Subagent models/tiers | DeepSeek mid throughout (`classify` → mid); not forced low |
| Startup tokens | first sub call id 278: **6282** input, cache_read **0**, $0.000360 |
| Total cost | **$0.025791** |
| Final answer quality | All three modules covered; **18** `.rs` paths cited (`mod.rs`, `classify.rs`, `sticky.rs`, `route.rs`, …). Acceptable fact density for a probe |

### Decisions after START_TS

| id | session_id | complexity | user_text (80) |
| --- | --- | --- | --- |
| 101 | main | mid | probe prompt (question only, no system-reminder) |
| 102–105 | `#subagent` | mid | distinct first-task Read prompts for decide/history/autoroute (102≈105 retry) |

Housekeeping triggers appeared on main (gemma low) — not in decisions rows.

---

## Measurement gaps (do not invent)

1. Historical subagent `#subagent` keys absent in DB (NULL session_id era).
2. Cache write tokens rarely populated; Haiku input_tokens often wrong (value 2).
3. `C_low_work` and returned summary token cost not measured — only upper bounds.
4. `subagent_type` available values beyond live `Explore` / schema description — not enumerated from Claude Code binary in this task.

---

## Experiment harness note

Local Claude Code + autoroute helpers (Mistral ladder):

- Put `OPENROUTER_API_KEY` in repo-root `.env` (`cp .env.example .env`)
- `source scripts/claude-code-env.sh` sources `.env` (and optional `experiments/.env`) then sets `/autoroute` + Mistral slots
- `./scripts/claude-code-experiment.sh` [-p prompt] runs inside gitignored `experiments/`
- Autoroute tiers in `config/autoroute.toml`: `ministral-8b-2512` → `mistral-small-3.1-24b-instruct` → `devstral-2512`
