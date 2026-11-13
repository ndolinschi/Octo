# Learned router — steps 1 and 2: label table, features, M1 (2026-11-13)

Design: `docs/superpowers/specs/2026-11-13-learned-router-design.md`. Every number here is in `results/metrics.json`
or `results/build.json`; `make all` rebuilds them from the pinned sources. 14 tests pass (`pytest`).

**Headline: negative.** With the repository held out, features of the task's text carry no usable signal about which
tier will solve a task. M1 (LightGBM) does not beat the per-tier prior, on any split, with any feature set, under any
of three tier cut-point schemes. The oracle shows large headroom, so what is missing is the predictor's input, not
room to save cost.

## 1. Sources (pinned)

- SWE-bench Verified, Hugging Face revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a` (500 tasks).
- SWE-bench/experiments, commit `40f164d5b8f1d249bf95a6df8b74b577fd8e519d`.
- LiteLLM price table, commit `46716fad56505ae5a0dc118a64da7a1bd6061ea3`; an OpenRouter catalogue snapshot of
  2026-11-13 (no revision; kept in `data/`).
- all-MiniLM-L6-v2 (Apache-2.0, ONNX, CPU) for sentence embeddings.

## 2. Label table

- 182 Verified submissions, 175 with per-instance outcomes.
- **Core** = `tags.agent == "mini-SWE-agent"` (48), minus 7 without per-instance outcomes and 2 whose per-instance
  `resolved` disagrees with their metadata by more than 1.5 points: **39 submissions, 34 models, 19 500 outcome rows.**
- Full slice = core + 19 single-model pass@1 submissions of other scaffolds (58 submissions).
- Excluded and listed in `results/excluded_submissions.csv`: 68 multi-model submissions, 22 with several attempts, 25
  with a model that was not priced, the 9 above.
- Table: 500 tasks × 3 tiers = 1 500 cells; every task has all three tiers. Soft label = share of the tier's
  submissions that resolved the task; hard label = majority.
- **Cost** is mini-SWE-agent's per-instance `cost` (a price table × tokens at run time, not a billed amount), present
  for 38 of 39 core submissions; every cell has at least one measured value.

### Model → tier

`results/models.csv`: 37 priced models, all read on 2026-11-13 (LiteLLM 28, OpenRouter 9); blend (3·input + output)/4
dollars per million tokens; current list prices are assumed equal to the price at run time (exceptions in `note`).

The router's own ladder cannot give the cut points: blended it is low 0.18, mid 0.2625, high 0.1295 $/M (not monotone;
see `docs/ladder-cost-check.md`) and only 2 of 34 core models are priced within it. Three schemes, declared before
training:

| Scheme | Cut points ($/M) | Core submissions low / mid / high |
| --- | --- | --- |
| **A (headline)**: log-price terciles over core models | 0.80 / 3.44 | 12 / 11 / 16 |
| B: fixed | 1 / 5 | 13 / 19 / 7 |
| C: terciles over core submissions | 0.93 / 3.44 | 13 / 10 / 16 |

### Labels and noise (scheme A, core)

- Mean soft label: low 0.488, mid 0.612, high 0.686. Mean cost per task: $0.169, $0.362, $0.517.
- Two runs of one tier disagree on a task with probability 0.31 (low), 0.23 (mid), 0.15 (high). Soft labels lie in
  (0.2, 0.8) for 56 % of low cells, 31 % of mid, 21 % of high.

## 3. Features (routing time only)

16 text statistics of the problem statement, the task's age, TF-IDF + SVD (32, fitted inside each training fold),
MiniLM embeddings reduced by PCA (32, fitted inside each fold). Not used: the repository id, `version`, repository
statistics. Leak guard: `routing_view()` is the only way to the task fields, and a test scrambles `patch`,
`test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `difficulty`, `hints_text` and asserts the features do not change.

## 4. M1 and the protocol

LightGBM on weighted (task, tier) rows with the tier as an input (and a one-model-per-tier variant). A four-point grid
declared before the first run, chosen by an inner GroupKFold(3) by repository. Seed 20261113 (+1, +2 for stability).
Isotonic and Platt calibration per tier on inner out-of-fold predictions. Decision: the cheapest tier with p ≥ τ, else
high. Curve area (AUC): upper hull of the operating points, averaged over cost between always-low and always-high.

## 5. Results (scheme A, core, all features)

Leave-one-repository-out, pooled over 500 tasks; 95 % intervals from 1 000 bootstraps over repositories.

| Policy | AUC | Cost saved at 95 % of always-high's quality | at 99 % |
| --- | --- | --- | --- |
| M1 raw | 0.594 [0.525–0.631] | 13.5 % | 2.7 % |
| M1 isotonic / Platt | 0.597 / 0.597 | 14.1 % / 14.8 % | 2.7 % / 3.7 % |
| Random mixture of fixed tiers at matched cost (= per-tier prior) | 0.594 | 13.8 % | 2.7 % |
| Length heuristic, 3 tiers | 0.592 | 14.1 % | 2.7 % |
| Oracle (true soft labels and per-task costs; optimistic, fits label noise) | 0.674 | 50.5 % | 43.1 % |

- **M1 minus the random mixture: +0.0000 [−0.004, +0.012]. Not significant.** Oracle minus mixture: +0.080.
- Per tier, M1's AUROC against the majority label is 0.482 / 0.484 / 0.487 and its Brier skill against the prior is
  −0.046 / −0.038 / −0.047 (negative everywhere). The unfitted length score (shorter = more likely solved) has AUROC
  0.564 / 0.575 / 0.558 — better than the fitted model.
- Time split (newest 150 tasks as test): M1 0.566, mixture 0.565, difference [−0.005, +0.009].
- Grouped 4-fold by repository: M1 0.592, mixture 0.594.
- Ablations (text statistics only; + TF-IDF; + embeddings; one model per tier; schemes B and C; the full matrix): no
  variant differs from the mixture; scheme B on the time split is worse than it.
- Calibration lowers ECE (low 0.061 → 0.019, high 0.057 → 0.036) but cannot add skill the ranking lacks.
- Not run: the current LLM classifier (JEV) — it cannot be replayed offline without API calls.

## 6. The orchestrator's diagnostic: where the label's variance is

Run on the same tables (scheme A, core; text statistics only):

- **Only 6–8 % of a tier's soft-label variance is between repositories.** Knowing the project explains little.
- **Tiers agree on which tasks are hard:** correlation of soft labels across tasks is 0.90 (low–mid), 0.93 (mid–high),
  0.88 (low–high). A task that is hard is hard for every tier; routing can only gain on the residual where tiers differ.
- **Inside one project the text still does not predict difficulty.** Predicting a task's mean soft label within django
  (231 tasks): Spearman 0.01–0.03 (5-fold), 0.08–0.09 (forward in time); sympy about 0; the unfitted length score gives
  0.16–0.29. Not tested within a project: TF-IDF and embeddings.

Reading: before any work is done, the statement of a task says almost nothing about whether a cheaper model will
manage it. This agrees with the 2026 work that routes on a partial trajectory (SWE-Router) rather than on the prompt.

## 7. ONNX

`models/m1_joint.onnx` (27 KB, 81 inputs): the tree model only; maximum absolute difference from LightGBM on 100 rows
7.2e-8 (`results/onnx_check.json`). The featurisation is not ported to the router.

## 8. TwinRouterBench (commit 78321f6; Apache-2.0)

970 step-level rows from 520 trajectories over five workloads; for SWE-bench **336 steps from 40 Verified tasks**.
Label `target_tier`: the cheapest of four tiers that keeps the whole trajectory passing. Available at step time: the
message prefix (median 11 messages), `step_index`, the system prompt; `total_steps` would leak. Its four tiers
collapse onto three under scheme A (low ∪ mid → low). Too small to train on alone; use it as the step-level
evaluation and exclude its 100 leaderboard tasks, which are Verified tasks, when both are used.

## 9. Assumptions and what is not verified

- Prices read now stand in for prices at run time; the 3:1 blend is a convention, agentic runs are more input-heavy.
- One stochastic run per cell; scaffold version and reasoning effort still vary inside the core.
- SWE-bench Verified is 12 mostly-Python repositories (django 231 of 500), probably seen in training by the models.
- Not done: repository-level features, a linear comparator on the full protocol, JEV replay, training on step data.

## 10. Corrections to the design

1. Tier cut points cannot come from the router's ladder; use quantiles of the models' prices and report sensitivity.
2. "The cheapest tier that solves the task" is ill-defined with soft labels (as one point it costs 0.70 and solves
   0.550, below always-mid); the upper bound is the Lagrangian oracle curve.
3. Cost per instance comes from mini-SWE-agent's own `cost`, not from tokens (not published per instance).
4. The single-scaffold slice is 39 submissions, not about 41.
5. The "random" baseline is the hull of fixed-tier mixtures; it equals the per-tier prior on the curve.
6. Criterion 2 should require Brier skill against the per-tier prior; calibration alone (criterion 3) proves nothing.
7. **The premise of M1 and M2 — that the task's text predicts the tier — is not supported by this data.** A text
   encoder (M2) on the same input has no reason to do better across repositories; the signal has to come from the
   session (what the agent did so far), which is also what the router sees every turn.
