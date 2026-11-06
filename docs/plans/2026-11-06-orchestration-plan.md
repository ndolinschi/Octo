# Orchestration routing — implementation plan (2026-11-06)

## Summary (10 lines)

1. **Worth doing as a gated experiment (P0–P2 shadow), not always-on.**  
2. Historical simple-readonly share of high/Haiku sessions: **0–75%** of spend (median-ish mix ~10–20%).  
3. Absolute upper-bound saving ≈ **$0–$0.018**/session if simple turns were free; A5 startup on DeepSeek mid was only **$0.00036**, historical gemma startup **~$0.002**.  
4. Live A5: model **did** call Agent (3× Explore) without a nudge when asked; all subagents shared one sticky key `#subagent`.  
5. **Biggest risk:** startup + thin absolute savings + nudge cache-bust + bad handoffs; concurrent subagents already corrupt sticky/stall/budget.  
6. **P0 is mandatory before P2–P3** — distinct `#sub:<hash>` keys + `parent_session_id`.  
7. Ship `orchestrate=false` + shadow scores first; turn on nudge only after P4.  
8. Do not fabricate `tool_use` or filter client tools.  
9. Measure success with H1–H5 (≥3 runs): quality ≥95% of always-high, lower $/solved.  
10. Evidence: [docs/research/2026-11-06-orchestration-investigation.md](../research/2026-11-06-orchestration-investigation.md).

---

## P0 — Per-subagent identity

**Goal:** Each Claude Code subagent gets its own sticky/budget/stall state; calls link to the parent session.

**Changes:**
- [`src/auto/body.rs`](../../src/auto/body.rs): replace `{id}#subagent` with `{id}#sub:{hash}` where hash is stable from first user task text (or Agent prompt when detectable); keep parent id parseable.
- [`src/history/`](../../src/history/) + migration: add `parent_session_id TEXT` on `calls`; fill from session_key parent when `#sub:`.
- Autoroute decide: subagent path defaults to **low** tier (skip JEV on first turn or classify first prompt), stall escalate as today.
- Update `.sqlx/` offline cache.

**Tests (`tests/` only):**
- Distinct keys for two subagent bodies with different first prompts, same UUID.
- Same prompt → same `#sub:` hash.
- Parent sticky untouched when subagent stalls.
- `parent_session_id` round-trip insert.

**Success:** Live multi-Agent session shows ≥2 distinct `#sub:` keys in `calls.session_id`.  
**Rollback:** revert key format to `#subagent`; drop column via reverse migration if needed.

---

## P1 — Detection (`needs_orchestration`)

**Goal:** Score multi-part / wide-read+reason tasks; shadow log only.

**Changes:**
- [`src/auto/jev/questions.rs`](../../src/auto/jev/questions.rs): add `needs_orchestration` noul question.
- [`src/auto/jev/parse.rs`](../../src/auto/jev/parse.rs) + [`types.rs`](../../src/auto/jev/types.rs): score field.
- Migration: `decisions.needs_orchestration_score REAL` (and optional bool).
- [`config/autoroute.toml`](../../config/autoroute.toml): `orchestrate = false` (default).
- Wire config through [`src/config.rs`](../../src/config.rs) / [`src/state.rs`](../../src/state.rs).
- When flag false: still ask JEV (or ask only if cheap — prefer always ask for shadow data), store score; **do not** change routing; optional log `purpose=orchestrate_shadow`.

**Tests:** parse fixtures for true/false scores; config default false; decision row stores score.

**Success:** Shadow decisions appear on multi-part prompts with scores; no behaviour change when flag off.  
**Rollback:** remove question + column; ignore score.

---

## P2 — Nudge (high + score + flag)

**Goal:** Encourage Agent delegation without fabricating tools.

**Changes:**
- Byte-stable system suffix helper (called from [`body::shape`](../../src/auto/body.rs) or route finish): instruct to delegate search/reading/simple parts via **Agent** tool; require subagent returns as files/lines/facts.
- Gate: `tier_after=high` ∧ `needs_orchestration` ≥ threshold ∧ `orchestrate=true`.
- `trigger = orchestrate` via [`routing.rs`](../../src/auto/routing.rs) whitelist.
- **Never** inject assistant/`tool_use` blocks.

**Tests:** shape appends exact suffix bytes when gated; no append when flag off / mid / low; trigger normalize.

**Success:** With flag on, high turns include suffix; cache-bust documented; Agent call rate rises on H-tasks in shadow metrics.  
**Rollback:** set `orchestrate=false` (immediate) or revert helper.

---

## P3 — Route subagents

**Goal:** Classify each subagent’s first task; default low; escalate on stall; per-sub budget.

**Changes:**
- On `#sub:` keys: classify from first `question_text` (or hold low until stall).
- `session_budget_usd` applies per sub key (already keyed by session_key once P0 lands).
- Optional: inherit parent `orchestrate` context in JEV state (`parent_tier`).

**Tests:** first subagent prompt “list files in X” → low; stall fixture → mid; budget cap on sub key.

**Success:** A5-like probe: Explore subagents land on **low** (or mid only after stall), not shared mid sticky.  
**Rollback:** force all `#sub:` to parent tier / old `#subagent` behaviour.

---

## P4 — Evaluation

**Goal:** Prove quality retention and lower $/solved.

**Protocol:**
- Tasks H1–H5 (multi-file read/explain) and optional write tasks with hidden tests.
- Modes: always-high vs high+orchestration (`orchestrate=true`).
- ≥3 runs each; record: key-point score or tests passed, total $, subagent startup $, wall time, max main `request_bytes`, `#sub:` count.
- Success: quality ≥ **95%** of always-high mean **and** cost per solved task lower with bootstrap CI.

**Harness location:** `experiments/` via [`scripts/claude-code-experiment.sh`](../../scripts/claude-code-experiment.sh) (gitignored outputs).

**Rollback:** leave flag false; archive failing eval JSON under experiments.

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Startup overhead eats savings | P0+P3 keep subagents on low; batch reads per Agent; measure A2 before enabling default |
| Low-quality handoffs (ants study 0/36 model-written) | Nudge requires files/lines/facts; P4 human key-point rubric |
| Latency / wall time | Cap concurrent Agents; eval wall-time gate |
| Permission prompts for Agent | Experiment script uses `--dangerously-skip-permissions` only in sandbox; document for interactive |
| Cache invalidation from nudge | Byte-stable suffix; enable only when flag on; avoid per-turn edits |
| Shared `#subagent` sticky (today) | **P0 first** |

---

## Open questions (user)

1. Shadow-only P1–P2 before any default-on? (**recommend yes**)
2. Who owns H1–H5 / hidden-test corpus?
3. Is ~$0.02/session upper bound enough vs FinOps (`gen-*` headers, E4 budget)?
4. Confirm Mistral ladder for shipping autoroute (see below) vs keeping Gemma/DeepSeek/Haiku.

---

## Do not do

- No fabricated assistant messages or `tool_use` / `tool_result`
- No filtering or rewriting client `tools[]` / schemas
- No Octo-synthesized subagent answers
- No comments in Rust unless asked
- No committing `experiments/` outputs or API keys

---

## Mistral model ladder (selected)

Smaller → smarter (OpenRouter pricing snapshot 2026-11-06):

| Tier | Slug | Role |
| --- | --- | --- |
| low | `mistralai/ministral-8b-2512` | cheap / subagents / housekeeping |
| mid | `mistralai/mistral-small-3.1-24b-instruct` | daily coding |
| high | `mistralai/devstral-2512` | harder agentic / planning |

Wired into [`config/autoroute.toml`](../../config/autoroute.toml) and Claude Code experiment env (Haiku/Sonnet/Opus slots map low/mid/high).
