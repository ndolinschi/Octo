# Debug: Claude Code tool call emitted as plain text (taskq / Agent)

**Date:** 2026-11-06 (Europe/Chisinau)  
**Scope:** diagnose only — no code, config, or data changes.  
**START_TS_MS:** `1793957732810` (`SELECT max(created_at) FROM calls` before live spend)  
**Live spend after START_TS_MS:** `13928` µ$ ≈ **$0.0139** (cap $0.10)

---

## 1. Summary

**Root cause (high confidence):** with the full Claude Code system prompt + tool list + `/plan`-wrapped user task, OpenRouter’s **Cloudflare** endpoint for `mistralai/mistral-small-3.1-24b-instruct` returned a single **`text`** content block whose body was a JSON array tool call (`[{"name":"Agent","arguments":{...}}]`), `stop_reason=end_turn`. Claude Code treated that as a final answer and stopped. The same model/provider emits a real **`tool_use`** block on a minimal `get_time` request, so this is a **context-dependent Anthropic-tools failure**, not a catalog “tools unsupported” flag.

**Contributing Octo bug (high confidence):** the request did hit `/autoroute`, but `question_text` stripped the entire `/plan` payload (task lived inside `<command-args>…</command-args>`), leaving an empty classifier question → **`passthrough`** (`tier_before/after=unset`, `trigger=none`, no `decisions` row, body forwarded **unshaped**). That skipped JEV and any mid→high escalation that might have avoided the bad Cloudflare/small response.

---

## 2. Evidence by step

### STEP 1 — Failing call

```sql
SELECT id, created_at, session_id, model, tier_before, tier_after, trigger, status, cost_micros
FROM calls WHERE message LIKE '%taskq%' OR input LIKE '%./taskq%'
ORDER BY id DESC LIMIT 10;
```

| id | created_at | session_id | model | tier_before | tier_after | trigger | status | cost_micros |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **323** | 1793957732810 | `7ff5d5e1-5adf-4b8b-a5f0-023972868706` | `mistralai/mistral-small-3.1-24b-instruct` | unset | unset | none | 200 | 7463 |

Output contains the text tool call (reconstructed from SSE `text_delta`):

```text
[{"name": "Agent", "arguments": {"description": "Create task queue", "prompt": "Create a local task queue in the ./taskq directory using Python 3.11...
```

(first ~200 chars; full reconstructed text length 2118).

Matching decisions:

```sql
SELECT id, purpose, complexity, is_hard_score, is_easy_score, substr(user_text,1,120)
FROM decisions WHERE session_id='7ff5d5e1-5adf-4b8b-a5f0-023972868706';
-- result: 0 rows
```

Exact call whose output contains `"name": "Agent"` as assistant **text** for this taskq session: **calls.id = 323**.

---

### STEP 2 — What the client sent (`calls.request_payload` → `payload.body`, mirrored in `input`)

| Field | Value (evidence) |
| --- | --- |
| Client `model` | `mistralai/mistral-small-3.1-24b-instruct` (Claude Code SONNET slot → mid Mistral; body.model) |
| Octo upstream model | same slug (passthrough; message_start.model) |
| `tools` count | **14** |
| `"Agent"` present? | **yes** |
| Agent `input_schema` keys | `type`, `$schema`, `additionalProperties`, `properties`, `required` |
| Agent `properties` keys | `description`, `effort`, `isolation`, `model`, `prompt`, `subagent_type` |
| `tool_choice` | **absent** |
| `thinking` | `{"type":"adaptive","display":"updates"}` |
| `max_tokens` | **32000** |
| `stream` | true |
| Extra body keys | `context_management`, `output_config` (`effort=high`), `safeguards`, `metadata` |

Plan mode signs:

- User message ends with `<local-command-stdout>Enabled plan mode</local-command-stdout>` after a `/plan` `<command-args>…taskq…` block.
- `safeguards[0].classifier_context.permission_mode = "plan"`.
- Tool list still includes write-capable tools (`Bash`, `Edit`, `Write`, `Agent`, …). `AskUserQuestion` description mentions EnterPlanMode/plan mode. **No** `EnterPlanMode` / `ExitPlanMode` tool entries in `tools[]`.

Tool names: `Agent`, `Artifact`, `AskUserQuestion`, `Bash`, `Edit`, `ListAgents`, `Read`, `ReportFindings`, `ScheduleWakeup`, `Skill`, `ToolSearch`, `Workflow`, `DeferredToolPlaceholder`, `Write`.

---

### STEP 3 — What Octo changed before forwarding

**Byte-level:** `json(input) == json(request_payload.payload.body)` for call 323 — **no differences** in `tools`, `tool_choice`, `system`, `metadata`, `max_tokens`, `thinking`, or messages.

**Why no shaping:** autoroute `decide` took the empty-question path:

1. `question_text` = `strip_question_noise(last_user_text)` — `src/auto/body.rs:51-65` removes tagged blocks.
2. `/plan` puts the real task inside `<command-args>…</command-args>` (plus `<system-reminder>`, `<command-name>`, `<local-command-stdout>`). After strip, question is **empty** (reproduced offline from stored body).
3. Fresh session, no stall → `route::passthrough(&req.body)` — `src/auto/decide/mod.rs:305-307`.
4. `passthrough` forwards the client body unchanged with `tier_before/after=unset`, `trigger=none` — `src/auto/decide/route.rs:242-244` (`encode_forward(body, meta)` — **does not** call `shape`).

Therefore for this call:

| Possible shaping change | Happened? | Code that would have done it |
| --- | --- | --- |
| Preserve tools / tool_choice / system / metadata | Yes (identity) | passthrough skips `shape` |
| Clamp `max_tokens` | No | `clamp_max_tokens` in `src/auto/body.rs:319-330` (only via `shape`) |
| Drop `thinking` | No | `drop_unsupported_thinking` `src/auto/body.rs:333-339` (mistral-small catalog has no `reasoning` / `include_reasoning`, so shape **would** drop thinking if classify had run) |
| Strip thinking blocks on model change | No | `src/auto/body.rs:299-316` |
| Add `provider` / `require_parameters` | No | not in shaping path; OpenRouter messages forward leaves unknown fields intact when present (`src/providers/llm/openrouter.rs:66-92`) |

---

### STEP 4 — What came back (`output` SSE / usage)

| Field | Value |
| --- | --- |
| OpenRouter provider | **Cloudflare** (`message_start.message.provider`) |
| Model | `mistralai/mistral-small-3.1-24b-instruct` |
| `stop_reason` | **`end_turn`** (`message_delta`) |
| Content block types (order) | **`text` only** (one `content_block_start` type=text, then text_deltas, stop) |
| Any `tool_use`? | **No** |
| Any `thinking` block? | **No** |
| First 300 chars of text | `[{"name": "Agent", "arguments": {"description": "Create task queue", "prompt": "Create a local task queue in the ./taskq directory using Python 3.11 and the standard library. The task queue should include the following components:\n\n1. Storage: SQLite file with the following fields for each task: id, queue, payload (JSON), status (queued, running, done, failed, dead), attempts, max_attempts, run_after, locked_until, last_error, idempotency_key (unique within the queue), created_at, updated_at.\n\n2. API (taskq/core.py):\n   - enqueue(queue, payload, *, max_attempts=3, delay=0, idempotency_key=None) -> id. If enqueue is called again with the same idempotency_key in the same queue, it should return the existing id and not create a duplicate.\n   - claim(queue, worker_id, visibility_timeout)` |
| usage | input **20404**, cache_read **null**, cache_write **null**, output **542**; `cost` ≈ 0.007463 USD (`cost_micros=7463`) |

---

### STEP 5 — Model capability (OpenRouter catalog + endpoints)

Fetched: `GET https://openrouter.ai/api/v1/models` and `…/models/<author>/<slug>/endpoints` (same public catalog Octo uses). Ladder from live `config/autoroute.toml` (Mistral).

| Model | context_length | tools | tool_choice | pricing prompt / completion (per token) | Endpoint provider(s) listing tools |
| --- | --- | --- | --- | --- | --- |
| `mistralai/ministral-8b-2512` | 262144 | yes | yes | 1.5e-7 / 1.5e-7 | **Mistral** (tools+tool_choice) |
| `mistralai/mistral-small-3.1-24b-instruct` | 128000 | yes | yes | 3.51e-7 / 5.55e-7 | **Cloudflare only** (tools+tool_choice listed) |
| `mistralai/devstral-2512` | 262144 | yes | yes | 4e-7 / 2e-6 | **Mistral** (tools+tool_choice) |

Catalog claims tools for all three; live CC-context behavior on Cloudflare/small still emits text tool JSON.

---

### STEP 6 — Minimal reproduction (≤ $0.10)

All via `POST http://127.0.0.1:8080/openrouter/v1/messages`, model pinned, `max_tokens=256`, tools=`[get_time]` empty object schema, user=`Call get_time now.`, no thinking. `(b)` adds `"provider":{"require_parameters":true}` — confirmed present in stored `input` for ids 325/327/329 (Octo forwards unknown fields).

| Run | Model | require_parameters | stop_reason | blocks | real tool_use? | provider | cost_micros |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 324 a | ministral-8b | no | tool_use | tool_use | **yes** | Mistral | 0 |
| 325 b | ministral-8b | yes | tool_use | tool_use | **yes** | Mistral | 0 |
| 326 a | mistral-small | no | tool_use | tool_use | **yes** | Cloudflare | 29 |
| 327 b | mistral-small | yes | tool_use | tool_use | **yes** | Cloudflare | 29 |
| 328 a | devstral | no | tool_use | tool_use | **yes** | Mistral | 0 |
| 329 b | devstral | yes | tool_use | tool_use | **yes** | Mistral | 0 |

CC-context / plan-mode repeats on the failing model:

| id | Setup | stop_reason | blocks | Agent-as-text? | provider | cost_micros |
| --- | --- | --- | --- | --- | --- | --- |
| 330 | original system + tools; shortened `/plan` user task; no thinking; max_tokens 512 | end_turn | text | no (wrote markdown plan) | Cloudflare | 6174 |
| **331** | original system + tools + thinking + original messages; stream false; max_tokens 600 | end_turn | text | **yes** (`"name": "Agent"`) | Cloudflare | 7696 |

Call **331** reproduces the production symptom (Agent JSON in a text block).

---

### STEP 7 — Root cause ranking

| # | Candidate | Verdict | Evidence |
| --- | --- | --- | --- |
| **a** | Model/provider lacks Anthropic tools → text fallback | **Partially confirmed (context-dependent)** | Catalog + endpoints list `tools`/`tool_choice`; minimal `get_time` → real `tool_use` on Cloudflare/small; full CC body → text Agent JSON (323, 331) |
| **b** | Plan mode instructions confused the model | **Contributing** | `permission_mode=plan`, `/plan` + “Enabled plan mode”; shortened plan-mode prompt (330) → markdown plan without tools; near-exact (331) → text Agent call |
| **c** | Octo shaping removed/altered tools / tool_choice / system | **Rejected for this call** | input ≡ request body; passthrough does not call `shape` (`route.rs:242-244`) |
| **d** | Routed to wrong tier vs config ladder | **Rejected as “wrong slug”; confirmed as “autoroute bypass”** | Model is config mid (`mistral-small`); but JEV never ran (0 decisions, unset/unset/none) because `/plan` XML emptied `question_text` → passthrough |
| **e** | Other | **Confirmed mechanism** | `strip_question_noise` deletes `<command-args>` contents (`body.rs:63-65` + `remove_tagged_blocks`), so slash-commands with the task only in command-args never classify |

Most likely chain: **(e)+(d bypass) → mid model on Cloudflare with huge CC/plan context → (a/b) text-shaped Agent call → client “done”.**

---

## 3. Capability table (current Mistral ladder)

| model | tools | tool_choice | context | provider(s) with tools |
| --- | --- | --- | --- | --- |
| mistralai/ministral-8b-2512 | yes | yes | 262144 | Mistral |
| mistralai/mistral-small-3.1-24b-instruct | yes | yes | 128000 | Cloudflare |
| mistralai/devstral-2512 | yes | yes | 262144 | Mistral |

---

## 4. Fixes ranked (do not implement here)

### F1 — Don’t passthrough when slash-command args hold the real task (effort: low)

- **Change:** `src/auto/body.rs` `strip_question_noise` / `question_text`: keep text inside `<command-args>` (and/or fall back to raw `last_user_text` when stripped result is empty but tools are present).
- **Test:** `tests/` — body with `/plan` + `<command-args>build taskq</command-args>` yields non-empty `question_text`; decide path does not return passthrough unset/unset.
- **Effect:** JEV runs; complex plan tasks can land on **high** (`devstral`) instead of client mid + Cloudflare.

### F2 — Detect “tool call printed as text” → `text_tool_call` escalate next turn (effort: medium)

- **Change:** response/session hook (e.g. `src/proxy/autoroute/mod.rs` `on_response` / stall-like detector): if assistant text parses as JSON list/object with `name`(+`arguments`) matching `tools[]`, or `<tool_call>` tags → set session escalate / trigger `text_tool_call`.
- **Test:** `tests/` fixture SSE/text from call 323 → detector true; unrelated markdown plan → false.
- **Effect:** next turn bumps tier even if client “done” on this turn (may need client retry nudge).

### F3 — Per-tier live smoke: assert real `tool_use` (effort: low–medium)

- **Change:** script or CI job (not necessarily proxy): one `get_time` Messages call per `config/autoroute.toml` slug; fail if no `tool_use` block.
- **Test:** `tests/` mock upstream + optional `#[ignore]` live gate.
- **Effect:** catches providers that advertise tools but break Anthropic tool calling.

### F4 — `provider.require_parameters: true` when `tools` non-empty (effort: low)

- **Change:** autoroute `shape` or OpenRouter messages pre-forward: inject `provider: { require_parameters: true }` if tools present.
- **Test:** `tests/` shaped body contains the field; unknown-field forward already works (ids 325/327/329).
- **Effect:** may avoid non-tool endpoints; **did not change** minimal Cloudflare/small outcome in this investigation (already returned `tool_use`). Unlikely alone to fix CC-context text Agent calls.

### F5 — Optional: buffer low/mid responses; convert text tool calls → `tool_use` or retry one tier up (effort: high)

- **Change:** stream tee / post-buffer in messages autoroute path; on text-tool-call pattern, either synthesize Anthropic `tool_use` for the client or retry with `next_up` model.
- **Test:** `tests/` with recorded 323-like SSE → client-visible `tool_use` or retry meta `trigger=text_tool_call`.
- **Effect:** masks provider failure for Claude Code; highest complexity / risk (streaming, duplication, cost).

**Suggested order:** F1 → F2 → F3 → F4 → F5.

---

## 5. Spend of this investigation

| Item | cost_micros | USD |
| --- | --- | --- |
| START_TS_MS baseline max(created_at) | — | calls created_at ≤ 1793957732810 excluded |
| Repro calls 324–331 sum | **13928** | **≈ $0.0139** |
| Cap | 100000 | $0.10 |
| Remaining | 86072 | ≈ $0.086 |

No code/config/data mutations in the Octo repo for this diagnosis; report only.
