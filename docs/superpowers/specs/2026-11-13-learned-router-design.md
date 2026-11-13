# Learned router — design (draft, 2026-11-13)

For the owner's diploma thesis: "A system of adaptive routing of language models based on machine learning to optimise
the cost and quality of solving agentic programming tasks". Status: **designed, nothing built.** The owner asked for
"the most interesting, best and useful variant" and left the choice to the orchestrator; this document is that choice
with the facts it rests on. Data audit behind it (what was fetched and what is from memory): kept in the session
scratchpad, summarised in section 2.

## 1. What is built

Today `apps/router` picks a tier (low / mid / high) with a call to another LLM (the JEV classifier:
`is_hard` / `is_easy` / `tools_enough`), then sticky bands, stall escalation and the price rule
(`apps/router/docs/autoroute.md`). Each decision costs money and up to a second, and the router's history has no
"solved" label (`history.md`: model, tier, tokens, `cost_micros`; `session_outcomes` only parses test summaries).

The thesis replaces the classifier call with a **trained model** and measures the difference.

- **Model — a tier-success predictor.** Input: the task text and the state of the session. Output: a calibrated
  probability that each tier solves the task (or, at step level, keeps the trajectory passing). Decision: the cheapest
  tier whose probability is above a threshold τ. τ is the cost–quality knob; sweeping it draws the thesis's main curve.
- **Two models, same features, so the comparison is clean:**
  - M1, gradient boosting (LightGBM) on tabular features plus frozen sentence embeddings of the task text. Trains on a
    CPU in minutes; it is the baseline and the fallback deliverable.
  - M2, a small text encoder fine-tuned end to end (about 100M parameters) with the tabular features fused in. Needs a
    GPU for a few hours.
- **Online adaptation.** A contextual bandit over τ per project (and per tier), fed by outcomes of real turns (stall,
  error streaks, retries, tests passing, the person's rewind). This is the "adaptive" of the title.
- **Serving.** Exported to ONNX and run inside the router process (`apps/router/src/auto`), behind the existing decide
  pipeline: the model replaces only the classifier's score; sticky, stall, budget and the price rule stay.

## 2. Facts the design rests on (data audit, 2026-11-13)

Verified by fetching the source now unless marked otherwise.

| Source | What it gives | Size | Cost data | Licence |
| --- | --- | --- | --- | --- |
| `SWE-bench/experiments` (GitHub) | per submission: `results.json` with resolved ids; some `per_instance_details.json` | Verified: 135 submissions × 500 tasks (471 solved by at least one); Lite 84 × 300; full 24 × 2294 | `instance_cost` in 47 of 182 Verified entries, 0 of 84 Lite | no LICENSE file in the repo (SWE-bench code is MIT) |
| TwinRouterBench (arXiv 2605.18859, GitHub) | **step-level** routing labels inside coding-agent trajectories: the cheapest of 4 tiers that keeps the trajectory passing; 11 models; a price table | not measured in the audit | price table × tokens, failed runs charged | Apache-2.0 |
| Terminal-Bench 2 leaderboard (Hugging Face) | per trial reward for 76 agent+model systems on about 89 tasks | 76 × ~89, several attempts | `cost_usd` in some trials | Apache-2.0 |
| Aider polyglot | one aggregate row per model | 68 rows | some token totals | — (no per-task outcomes: not usable for labels) |

- A SWE-bench submission is an agent **and** a model: labels confound the two. The clean slice is the runs of one
  scaffold (mini-SWE-agent, about 41 submissions with per-instance details).
- Fields usable at routing time: `problem_statement`, repo, `base_commit`, `created_at`, version, the repository's
  structure, the session so far. **Leak if used:** the gold `patch`, `test_patch` / `FAIL_TO_PASS`, the human
  `difficulty` label (annotators saw the patch), probably `hints_text`.
- **The thesis is not the first to route inside coding-agent sessions.** Published in 2026: TwinRouterBench (step-level
  routing benchmark), SWE-Router (a value head reads a cheap model's partial trajectory), Scrouting (a scout model routes
  to one of four fixers). Closest bandit work is MixLLM, for single queries. What is open: a calibrated three-tier
  probability model, online threshold adaptation by a bandit, and integration into a production proxy with measured,
  not simulated, cost. Not verified in the audit: the exact definitions of APGR / CPT / AIQ, and licences of RouterBench
  and several other routing datasets.
- This environment: 4 CPUs, 15 GB RAM, no GPU; Hugging Face and public `git clone` reachable; lightgbm, scikit-learn,
  xgboost and onnxruntime downloadable. M1 can be trained here; M2 cannot.

## 3. Data

1. **Task level (which tier solves the task).** The SWE-bench Verified matrix, each submission mapped to a tier by its
   model's blended price per million tokens at the time of the run (cut points from the router's own price ladder;
   sensitivity to the cut points reported). Core = the single-scaffold slice; the full matrix as a noisier extension.
2. **Step level (which tier is enough for this turn).** TwinRouterBench's labels, mapped from its four tiers to the
   router's three. This matches what the router decides in production: a tier per turn, not per task.
3. **Own runs (measured cost, the owner's agents).** A subset of tasks through the harness at each tier, with the
   router's own cost records. Needs the owner's machine, keys and a budget; it is the only source of measured cost.
4. **Weak labels for the online layer.** From the router's history: stall, error streak, retry, escalation.
   Prerequisite, small and independent: the harness reports a "solved" signal per turn or task to the router
   (tests passed, the person accepted, a rewind) so the history gains the label it lacks.

Splits: leave-one-repository-out; a time split (train on older tasks); a "newer models" split. Never a random split
over tasks of one repository.

## 4. Features (routing time only)

Task text (embedding or encoder input); repository statistics (size, language mix, test count); session state (turn
index, tokens in context, tool calls so far, share of failed tool calls, files touched, whether tests ran and their
last result, the current tier and how long it has held); role (orchestrator or sub-agent, depth) and the harness's
hint; nothing from the gold patch or the tests that define success.

## 5. Evaluation

- Offline: the cost–quality curve (share of tasks solved against cost relative to always-high) for M1, M2 and
  baselines: always-low, always-mid, always-high, random, the current JEV classifier replayed on the same tasks, a
  keyword/length heuristic, and the oracle (the cheapest tier that solves each task). One number per curve: the area
  under it between always-low and always-high; plus calibration (reliability diagram, ECE) of the probabilities.
- Online adaptation: simulated on held-out repositories arriving as a stream — regret of the bandit against the best
  fixed τ, and how many tasks it needs to get within a stated margin.
- End to end: the harness with the model in the router against the same tasks with JEV: tasks solved, total cost
  (measured), decision latency, classifier spend saved.

## 6. Acceptance criteria

1. A reproducible script builds the task × tier label table from the public sources, records each source's commit or
   revision, and prints its size; no leaking field is among the features (a test asserts the feature list).
2. M1 is trained with leave-one-repository-out and its curve is reported against every baseline and the oracle, with
   confidence intervals from repository-level bootstrap.
3. M1's probabilities are calibrated: ECE reported per tier before and after calibration.
4. M2 is trained on the same splits; the thesis reports where it beats M1 and where it does not.
5. The bandit's regret curve is reported on the stream simulation, against fixed-τ and against no adaptation.
6. The model runs in the router as ONNX: a decision takes under 20 ms on a CPU (measured p50 and p99), with a
   fallback to the current rule when the model file is missing or errors; `cargo test -p octo` covers load, a
   decision and the fallback.
7. A setting chooses the classifier (`jev` | `learned`), default unchanged; with `learned` no classifier call is made
   and the decision's record names the model version and the probabilities.
8. End to end on the owner's machine: at least one run of a fixed task set with `learned` against `jev`, with measured
   cost, solved counts and latency. If it cannot be run, the thesis says so and reports offline results only.
9. The thesis states its limits in the text: labels confound model and scaffold; one stochastic run per cell; SWE-bench
   Verified is 12 mostly-Python repositories and likely seen in training by the routed models; cost in public data is
   simulated from a price table.

## 7. Risks

1. **Labels.** Agent and model are confounded, each cell is one run. Mitigation: the single-scaffold core, repeated own
   runs for a subset, uncertainty reported.
2. **Transfer.** Public tasks are not the owner's sessions. Mitigation: the second domain (Terminal-Bench 2), own runs,
   and the online layer, whose job is exactly this gap.
3. **Novelty.** Three 2026 papers cover routing in coding agents. The claim is narrower and must be stated so: calibrated
   three-tier probabilities, online threshold adaptation, a production integration with measured cost; TwinRouterBench
   and SWE-Router are baselines or data, not ignored.

## 8. Order of work

1. Label table and features from the public sources (here, CPU). 2. M1, baselines, curves, calibration (here).
3. The harness → router "solved" signal and the weak-label export (Go and Rust, small). 4. ONNX serving and the setting
(Rust). 5. Bandit and the stream simulation (here). 6. M2 on a GPU (the owner's or a rented one). 7. Own runs and the
end-to-end comparison (the owner's machine). Steps 1, 2 and 5 need nothing from the owner; 6 and 7 do.

## Open questions for the owner

The defence date; whether a GPU is available for M2; the budget for own runs; whether the department requires a neural
model as the main one (if not, M1 can be the main model and M2 the extension).

---

# Revision 2 (2026-11-13, after three stages of experiments)

The owner said "continue" after the orchestrator proposed this revision; it replaces sections 1, 5, 6 and 8 above where
they differ. Evidence: `apps/router/ml/REPORT.md` (stages 1–3, every number reproducible with `make`).

## What the experiments decided

Tested on public data and **not supported**: predicting the tier from the task's text (gain +0.000 [−0.004, +0.012];
the ceiling for any such predictor is about +0.017 curve area); a learned cascade on the cheap model's early trajectory
(one positive cell of twelve); choosing the tier per step inside a coding session (with prompt caching even the oracle
saves 0.8 % [−7.2, +8.1]). Most of the "oracle headroom" of task-level routing is noise between runs and models.

**Supported:** (1) which concrete model fills a tier matters (+0.025 to +0.046), and list price per token misorders
models by cost per solved task; (2) the kind of workload is the strongest routing signal measured (81.1 against 63.6 on
TwinRouterBench's mixed bank); (3) an operating point can be held online at a declared quality target.

## What is built instead

The thesis's "adaptive routing based on machine learning" means three learned parts and one study:

- **L1, a ladder that learns itself.** Instead of a ladder fixed by list price, an online learner (a bandit over
  concrete models, cost-aware) estimates each model's success and cost per task from outcomes and keeps the tiers filled
  with the models that are best per solved task; it re-learns when a model is added or changes.
- **L2, routing by kind of work.** A small classifier of the request's workload (coding-agent turn, housekeeping call,
  plain question, …) from what is known at routing time (system prompt, tools, client, the first message's shape) sets the
  tier policy per kind. It replaces the per-request LLM classifier call.
- **L3, a quality controller.** An online controller holds a declared target ("at least 95 % of the best model's
  quality") by moving the mixture / threshold, with a stated violation rate.
- **S, the study of limits** as the scientific core: the noise ceiling of task-level routing and its decomposition;
  the negative results with intervals; why per-step switching does not pay under prompt caching.

## Acceptance criteria (replace 2–5; 1 and 6–9 stand, with "model" read as L1–L3)

2'. L1 is evaluated on the task × model matrix as a stream: regret against the best fixed model and the best fixed
    triple in hindsight, the number of tasks until it is within a stated margin, and the cost per solved task against a
    ladder chosen by list price; with intervals over stream orders; and a scenario where a better model appears mid-stream.
3'. L2 is evaluated by held-out trajectories within known workloads and, separately, on an unseen workload (expected
    not to transfer — reported); the cost–quality result is given in the benchmark's own metric against the workload
    prior and always-low / always-high.
4'. L3 reports, for a declared target, the achieved quality, cost and the share of streams that violate the target,
    against the offline mixture; a controller that violates the target more often than the offline mixture is reported as such.
5'. The study S is reproducible from pinned public sources and states its limits (single runs, 12 mostly-Python
    repositories, price-table cost, the benchmark's caching rules).

## Still needed from the owner

The defence date; whether the department accepts this framing of the topic; own runs for a measured (not simulated)
end-to-end comparison (criterion 8) — the router must first log a solved / not-solved outcome per session.
