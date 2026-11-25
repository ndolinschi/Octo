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

# Stage 2: where is the signal, if not in the task's text? (2026-11-13)

Full text: `results/stage2_report.txt`; numbers: `results/stage2_*.json`; figures: `figures/stage2_*.png`. Same data as
stage 1 (39 core submissions × 500 tasks, scheme A as the headline); stage 1's code and numbers untouched; 18 tests pass.

**Headline: on this data no signal at the level of a single task beats the fixed-tier mixture, and per-repository
adaptation does not either. Most of the oracle's headroom is noise between runs and models.**

| Signal | Gain over the fixed-tier mixture (curve area, scheme A) |
| --- | --- |
| Choosing the concrete cheap model (a model-level effect, not routing), stopped at step 5 / after the run | +0.046 [+0.041, +0.049] / +0.025 [+0.020, +0.032] |
| Task-level ceiling: an oracle built on half of each tier's submissions, scored on the other half | +0.014 [−0.029, +0.039], not significant (in-sample on the same halves: +0.097; stage 1's full-data oracle: +0.080) |
| Cascade on what the cheap run looked like afterwards (`api_calls`, `cost`) | −0.003 [−0.011, +0.004] |
| Early cascade on the first K = 5 / 10 / 20 steps of the cheap run's trajectory | +0.003 / 0.000 / −0.003, none significant (a perfect stop at step 5 would give +0.068) |
| Per-repository bandits (Thompson, UCB, with and without a prior) | at most 0.017 per task available near break-even; not captured — every adaptive policy trails the best fixed tier |

- **Reliability.** A tier's soft label is reliable (split-half 0.90 / 0.92 / 0.965). Which tier is better on a given task
  is not: high − low 0.54 [0.38, 0.68], mid − low 0.11 [−0.26, 0.31], high − mid 0.18 [−0.14, 0.41].
- **Failure of a cheap run is detectable, moderately:** AUROC within a model 0.705 from calls and cost, 0.54 / 0.61 / 0.64
  from the first 5 / 10 / 20 steps (a test checks nothing after step K is used), 0.72 from the full trajectory. It does not
  pay at these price ratios: escalating costs the cheap run plus the dear one.
- **Step level** (TwinRouterBench, 336 steps from 40 tasks, leave-one-task-out): step-time features predict the needed
  tier with accuracy 0.66 [0.60, 0.71] and log loss 0.108 [0.029, 0.179] better than the majority tier. Small data; it
  only shows the session prefix carries some information per step.
- **Constrained online control** (quality ≥ 95 % of always-high): a threshold bandit reproduces the offline mixture
  (0.953 of the quality at 0.871 of the cost; the mixture: 0.951 at 0.866); a Lagrangian Thompson sampler violates the
  constraint in every stream.

## The orchestrator's reading and its limits

1. "The cheapest tier that will solve this task" is not a learnable target on public SWE-bench data: there is almost
   nothing reproducible to predict at the task level. This is a result about the data as much as about models.
2. **A limit of that conclusion.** A tier here is a population of different models (qwen2.5-coder-32b solves 9 %, others
   in the same price tier far more), and each cell is one run. The split-half "noise" therefore mixes run-to-run chance
   with differences between models inside a tier. A router in production chooses among three concrete models; whether
   the advantage of one concrete model over another on a task is reproducible is **not measured** here (it needs
   repeated runs of the same models; five core models have two submissions each, which could give a first estimate).
3. What is supported: the choice of the concrete model inside a tier matters more than any per-task routing measured
   here; an operating point can be held online at a declared quality target; the session prefix carries some step-level
   information.
4. What the router should log to make any of this learnable on its own traffic: the model, steps, tool errors, test
   runs, and a solved / not-solved outcome per session (its history has no such label today).

# Stage 3: three checks (2026-11-13)

Full text: `results/stage3_report.txt`; numbers: `results/stage3_*.json`. Stage 1 and 2 files and numbers untouched;
22 tests pass. No paid API was called.

**Verdicts.**

1. *Per-task tier prediction from the prompt* — **not supported.** Stage 1's model minus the mixture: +0.000
   [−0.004, +0.012]. The corrected ceiling for any task-level tier predictor: +0.017 curve area (scheme A). With concrete
   models the room is +0.03 to +0.05, but text features reach AUROC ≤ 0.555 for "cheap fails and dear solves" and a text
   router gains +0.000 to +0.008.
2. *An early-trajectory detector makes a cascade that beats fixed tiers* — **not supported.** On four concrete triples
   with honest cost: no gain in two; in one a random stop does better; one positive cell of twelve (+0.010
   [+0.002, +0.024] at K = 20). A perfect stop would gain +0.04 to +0.07.
3. *Step-level tier selection saves cost at bounded risk* — **not supported for coding agents; on the mixed benchmark
   it is mostly a workload effect.** On TwinRouterBench's SWE steps, under the benchmark's own cache-aware cost model,
   even the oracle saves 0.8 % [−7.2, +8.1] of the always-high bill: with prompt caching, switching model per step is
   nearly worthless. Over all 970 steps the step model scores 70.6 [66.9, 74.8] against 63.6 for always-low, 90.7 for
   the oracle and **81.1 for a prior that only knows the workload**; left-one-workload-out it scores 57.6 (does not
   transfer).

**Check 1, the stage 2 ceiling.** No arithmetic bug. The figure's "one split" came from a separate random generator and
sits at the 97.5th percentile of the 200 splits (+0.041), which is why it looks better than the mean; its caption needs
fixing. One definitional flaw is corrected in `stage3_audit.py`: the oracle's hull lacked fixed mid, which the mixture
had. Corrected ceiling: A +0.017 (93 % of splits above 0), B +0.016, C +0.010 — about a fifth of the in-sample oracle.
Stage 2's interval was the spread across splits, not an uncertainty of the mean. Run-to-run noise: two runs of the same
model (four models have repeats; versions or reasoning effort differ, so an upper bound) disagree on 10–17 % of tasks
(kappa 0.66–0.74); different models of one tier disagree on 34 % (low), 25 % (mid), 17 % (high).

**Check 2, concrete triples** (declared by rule before reading outcomes: gpt-5-nano / mini / gpt-5; haiku / sonnet /
opus 4.5; the strongest per price band; the cheapest per price band). **Price per token does not order cost per task**:
gpt-5-mini costs less per task than gpt-5-nano and solves far more; deepseek-v3.2 costs more per task than
gemini-3-flash and solves less — two of four ladders collapse before any routing. Noise-bounded oracle gain over the
best mixture of three: +0.03 to +0.05. The cheap model's early trajectory predicts its own failure weakly (AUROC up to
0.68), not the useful event "cheap fails and dear solves" (about 0.5).

**Check 3, generating step labels** (estimate, the benchmark's algorithm and prices): $3 per task on the bank's short
trajectories; about $55–85 per task at realistic lengths; 500–2 000 tasks would cost $1.5k–6k (short) or $30k–170k.

**Limits.** The bank's SWE trajectories are short (8.4 routed steps) and the caching rules are the benchmark's, not an
invoice; thresholds were read off the out-of-sample frontier, not chosen in a nested loop; pure run-to-run noise (same
version and effort) is not in public data; a router that switches rarely and escalation from cheap to mid were not tested.

## What the thesis can and cannot claim after three stages

- **Cannot:** that a learned model predicts the tier for a task or for a step of a coding agent, or that a learned
  cascade beats fixed tiers — each was tested and is not supported on public data.
- **Can, with numbers:** (1) the noise ceiling of task-level routing, decomposed into run-to-run chance and differences
  between models, and that published-style oracle headroom is mostly noise; (2) the concrete model that fills a tier
  matters (+0.025 to +0.046) and price per token misorders models by cost per solved task; (3) the kind of workload is
  the strongest routing signal measured (81.1 against 63.6); (4) an operating point can be held online at a declared
  quality target; (5) with prompt caching, per-step switching inside a coding session does not pay.

# Stage 4: the three learned parts of revision 2 (2026-11-13)

Full text: `results/stage4_report.txt`; numbers: `results/stage4_{ladder,controller,workload}.json`. 33 tests pass.
No paid API. Earlier stages untouched.

**Headline: on this data none of the three learned parts beats its strongest simple baseline.**

| Part | Result | Strongest baseline | Clears it? |
| --- | --- | --- | --- |
| L1, a bandit over 33 concrete models (reward = solved − cost / V, V = $1 per solved task) | 0.550 [0.469, 0.602] per task | a ladder read off a leaderboard measured on a held-out half: 0.686 (the list-price ladder, as production is configured: 0.310) | beats the list-price ladder at every V but quality-only; **does not beat the leaderboard**; never within 0.02 per task of the best model in 500 tasks |
| L2, recognising the kind of work from the first request | accuracy 1.000 (0.996 from message shape alone); per-workload policy 81.1 [79.2, 83.1] on TwinRouterBench | the same policy given the true workload: 81.1 | equal — **a lookup of the scaffold, not a learning problem**; an unseen workload falls to 61 without a fallback, 54–56 with a safe one (99–100 % of trajectories pass) |
| L3, a controller holding "quality ≥ 95 % of always-high" (lower-confidence-bound, conf 0.9) | quality 0.962, saving 10.7 % [7.5, 15.9], target violated in 11 % of streams | an offline mixture tuned on a held-out half at the same violation rate: 10.6 % | **ties on tiers, worse by 0–22 points of the bill on models**; its declared confidence under-covers about twofold |

What L1 does show: adaptation. A new best model withheld until task 250 is adopted in a median of 35–50 tasks; a model
that degrades is dropped in 16–55 (forgetting halves that and costs 35–90 % more regret when nothing changes). A
price-band prior speeds adoption only when the band's other models are good under the objective. Exploring costs
$12–143 and 3–52 solves over 500 tasks against always using the hindsight-best model.

On stationary traffic of the same kind of tasks a leaderboard aggregate is sufficient and learning only adds
exploration. The case where a learned ladder should win — the router's own work ranks models differently from the
public leaderboard — cannot be shown with one benchmark; it is what stage 5 tests across benchmarks.

For a production integration the router would have to log per session: a scaffold fingerprint (hash of the system
prompt and the sorted tool names), the served model and cost, its decision probabilities, and an outcome proxy (the
last test run in tool output — already parsed into `session_outcomes`; accept / rewind in the harness; a follow-up
correction). All are noisy proxies of unknown noise rate.

# Stage 5: does a ladder that learns online beat a leaderboard when the work differs? (2026-11-13)

Full text: `results/stage5_report.txt`; numbers: `results/stage5_xbench.json`. 64 tests pass. No paid API.
SWE-bench Verified (stage 4's 33 models) plays "the leaderboard"; another benchmark plays "the router's own traffic".
Sources pinned in `config.py`: Terminal-Bench 2 leaderboard (Hugging Face, revision 572b2614…, Apache-2.0; 30 431 kept
trials over 89 tasks) and SWE-bench Multilingual (14 mini-SWE-agent submissions, 300 tasks).

**Answer: only when the leaderboard's pick is clearly wrong on the target.**

| Target | Does the ranking transfer? (Spearman) | Leaderboard pick → best on the target | Learner minus leaderboard ladder (solved per task) |
| --- | --- | --- | --- |
| Terminal-Bench 2, one scaffold (5 matched models, 89 tasks) | 0.40 [−0.10, 0.90] | minimax-m2.5 (falls from 1st to 4th of 5) → opus-4.6 | **+0.09 [+0.03, +0.14]** in one pass (Thompson with a leaderboard prior); about +0.18 on long resampled streams |
| Terminal-Bench 2, all scaffolds (11 models) | 0.62 [0.39, 0.81] | opus-4.5 → opus-4.6 | +0.004 to +0.019 in one pass (not distinguishable from 0); +0.11 to +0.13 at 2 000 resampled decisions |
| SWE-bench Multilingual (12 models, 300 tasks) | 0.86 [0.48, 0.93] | opus-4.5 → gemini-3-flash (top four within 0.03) | **−0.01 to −0.08**: the learner loses |

Qualifications that must travel with the positive number:

1. On the single-scaffold Terminal-Bench target a **uniform random** choice also beats the ladder (+0.05): the ladder
   had picked one of the worst models there.
2. A leaderboard measured on **a held-out half of the target's own tasks** beats every learner by about 0.1 solved per
   task (+0.20 over the ladder on the same tasks where learners get +0.08).
3. Resampled streams repeat the same tasks and so flatter learners.
4. On Terminal-Bench a "model" is model + scaffold + serving; cost is missing or imputed for three of five models.

Break-even (a simulation): the learner wins once the leaderboard ladder's own regret on the traffic exceeds about
0.01–0.03 solved per task within 2 000 decisions, 0.03–0.05 within 500, 0.04–0.09 within one pass of 90–300 tasks. Rank
correlation alone is a poor guide; what matters is whether the top pick changes and by how much.

Cost does not transfer across scaffolds: deepseek-v3.2 costs $0.45 per task on Verified and $0.031 under Terminus 2
(cost-per-solved rank correlation −0.5), so a cost-aware ladder read from another scaffold can be badly wrong, and
learners recover almost all of that (reverse control at V = $1: +0.432 of a possible +0.434).

On the owner's router: an error of the Terminal-Bench size (0.2 solved per task) shows with about 50 sessions per model;
one at the break-even size needs about 800–2 000 per model, more with a noisy outcome proxy. The cheaper first step is to
replay 50–100 of the owner's own tasks on each candidate model offline — the held-out-half baseline, the best policy
measured in five stages.

# Stage 6: across tasks from one-line edits to hard problems, does the brief's text predict the tier? (2026-11-20)

Full text: `results/stage6_report.txt`; numbers: `results/stage6_{labels,eval,eval_B,eval_equal_tokens,m2,probe,sources}.json`;
figures: `figures/stage6_{gains,leaks,probe}.png`. Protocol, gate and the 60 probe briefs were committed before any stage-6
data was fetched (`fixtures/stage6_protocol.md`, `fixtures/stage6_probe.json`). One debugging run of the M1' pipeline (50
bootstraps, no M2') was seen before the final run; nothing in the protocol changed after it. Earlier stages untouched.
76 tests: 62 pass, 14 skip (stage 1–5 tests whose `data/` is absent in this checkout). No paid API.

**Headline: not supported.** Pooled over four benchmarks the text model looks useful (+0.027 curve area over the
fixed-tier mixture), but a lookup of the benchmark's identity does better (+0.034), and with the benchmark held out the
gain falls to +0.0003 (M1') / +0.004 (M2'), below a one-feature length model (+0.013). Inside each benchmark the gain is
positive but 0.0002–0.009 — 0.4–7 % of the oracle headroom. The wide range of difficulty is there in the labels; the text
does not carry it across benchmarks.

## Sources (pinned in `config.py`; `results/stage6_sources.json`)

| Source | Tasks | What a task is | Models priced (low / mid / high, scheme A) | Licence |
| --- | --- | --- | --- | --- |
| CanItEdit (HF `nuprl/CanItEdit` 3c07f38, predictions `WhyDoYouCare/CanItEditPredictions` 9481967, 13 MB) | 105 | one instructed edit of a Python file; 3 runs × 9 models, tested | 6 / 1 / 2 | MIT / MIT |
| BigCodeBench Instruct (`bigcode/bigcodebench` b74c0d0 v0.1.4, `bigcode/bigcodebench-perf` 249b305, 3 MB) | 1 140 | NL → library-using function; greedy 0/1 | 29 / 17 / 10 (70 of 126 unpriced, excluded) | Apache-2.0 / none stated |
| LiveCodeBench (site repo f186ab5 `performances_generation.json` 7 MB; statements `livecodebench/code_generation_lite` 0fe84c3, 4.5 GB streamed, 1.9 MB kept) | 1 055 | LeetCode / AtCoder / Codeforces problem; pass@1 | 5 / 9 / 10 (4 unpriced) | none stated (code MIT) / "cc" |
| SWE-bench Verified (stage 1's 39 mini-SWE-agent submissions; statements at HF c104f84) | 500 | repository issue, agentic | 12 / 11 / 16 | none stated |

Prices: LiteLLM 46716fa (first-party key where present, else one named host; open-weights models at a host's list price,
noted per model in `stage6_data.PRICE_KEYS`). Tiers: stage 1's scheme A (0.80 / 3.4375 $/M blended), scheme B (1 / 5)
as sensitivity. Cost = tier mean price × tokens per task: 2 000 (CanItEdit, BigCodeBench) and 10 000 (LiveCodeBench)
are assumed; SWE-bench's 108 591 is implied by mini-SWE-agent's measured cost.

**Rejected:** RouterBench (pickle files — unsafe to load —, no licence, 2023 models, MBPP prompts embed the tests);
EvalPlus HumanEval+/MBPP+ (no public per-task × per-model table found; saturated by frontier models); HumanEvalPack,
CodeEditorBench (no per-model outcomes published; CodeEditorBench is 2.1 GB); LiveCodeBench self-repair (the input is
each model's own broken code, so tasks differ per model); Aider polyglot (aggregates only); Terminal-Bench 2 (89 tasks
would add a fifth source at the hard end; not done for time — a gap).

## Labels: the range is wide, the tier contrast is not reliable

| Source | Mean solved low / mid / high | Cheapest sufficient low / mid / high / none | Split-half: soft label | high − low | cheapest-tier kappa |
| --- | --- | --- | --- | --- | --- |
| CanItEdit | 0.34 / 0.24 / 0.69 | 0.31 / 0.07 / 0.38 / 0.24 | 0.83 (low) | 0.36 [0.19, 0.48] | n/a (one mid model) |
| BigCodeBench | 0.34 / 0.42 / 0.44 | 0.34 / 0.12 / 0.06 / 0.49 | 0.93–0.96 | 0.50 [0.33, 0.60] | 0.69 [0.62, 0.73] |
| LiveCodeBench | 0.53 / **0.79** / 0.64 | 0.54 / 0.28 / 0.01 / 0.17 | 0.80–0.93 | −0.04 [−0.92, 0.32] | 0.34 [0.18, 0.46] |
| SWE-bench Verified | 0.49 / 0.61 / 0.69 | 0.57 / 0.10 / 0.06 / 0.27 | 0.90–0.96 | 0.53 [0.38, 0.63] | 0.57 [0.43, 0.64] |

- Task difficulty spans the full range in every source (the task mean runs from 0.0–0.1 at the 10th percentile to
  0.9–1.0 at the 90th). How hard a task is, is reliable (0.80–0.96). **Which tier is enough** is much less so
  (advantage reliability −0.04 to 0.53; cheapest-tier kappa 0.34–0.69): stage 2's finding holds on the wide range.
- Price tiers are not ordered by ability everywhere: on LiveCodeBench the mid tier (o3-mini, o4-mini, R1 — reasoning
  models) solves 0.79 and the high tier (GPT-4-Turbo, GPT-4o, Claude 3.5/4) 0.64; on CanItEdit the single mid model
  (gemini-2.5-flash) is below the low tier.
- The source explains 7 % / 20 % / 8 % of the low / mid / high label variance (eta²).

## Results (scheme A, 1 000 group bootstraps stratified by source)

| Policy (curve area minus the fixed-tier mixture) | (a) Pooled 5-fold | (c) Leave one source out |
| --- | --- | --- |
| M1' (LightGBM, MiniLM embeddings + text statistics, isotonic) | +0.0271 [+0.0233, +0.0307] | +0.0003 [+0.0002, +0.0005] |
| M2' (MiniLM-L6 fine-tuned, temperature-scaled) | +0.0235 [+0.0211, +0.0276] | +0.0042 [+0.0024, +0.0062] |
| **source-id prior** (benchmark identity only) | **+0.0344 [+0.0294, +0.0384]** | not available |
| source id + length (fitted) | +0.0321 [+0.0277, +0.0356] | not available |
| length only (fitted logistic, one feature) | +0.0225 [+0.0185, +0.0267] | **+0.0131 [+0.0092, +0.0165]** |
| length rank (unfitted) | +0.0024 [+0.0005, +0.0053] | +0.0024 [+0.0005, +0.0053] |
| the router's text rule (`band::fallback`) | +0.0000 | +0.0000 |
| oracle (true soft labels; optimistic) | +0.0621 | +0.0621 |

Mixture area 0.5761 [0.5589, 0.5923]. **(b) Within each source** (pooled-CV predictions; gain over that source's mixture;
oracle headroom in brackets):

| | CanItEdit (0.123) | BigCodeBench (0.048) | LiveCodeBench (0.021) | SWE-V (0.047) |
| --- | --- | --- | --- | --- |
| M1' | +0.0064 [+0.0034, +0.0203] | +0.0018 [+0.0006, +0.0043] | +0.0011 [+0.0007, +0.0017] | +0.0006 [+0.0001, +0.0053] |
| M2' | +0.0088 [+0.0032, +0.0198] | +0.0002 [+0.0001, +0.0021] | +0.0013 [+0.0010, +0.0018] | +0.0003 [+0.0001, +0.0020] |
| M1' trained inside the source only | +0.0098 | +0.0015 | +0.0013 | +0.0027 |
| length rank (unfitted) | +0.0025 | +0.0048 | +0.0008 | +0.0021 |
| human difficulty tag (not available at routing time) | – | – | +0.0025 | +0.0018 |

- **How much of the pooled gain is source identity: all of it.** The source-id prior beats both text models pooled;
  without the source (leave-one-out) M1' keeps 1 % of its pooled gain and M2' 18 %, both below the fitted length model.
- With the source held out, the predicted probabilities rank tasks **worse than chance** across sources (AUROC of the
  low tier against the majority label 0.41 M1', 0.44 M2'; Brier skill −0.10, −0.08), and near chance inside the held-out
  source (0.52–0.58).
- Inside a source, the text does rank difficulty where the benchmark has a real difficulty gradient in its wording:
  LiveCodeBench AUROC 0.76 (M1') / 0.78 (M2') for the low tier, BigCodeBench 0.62 / 0.64, CanItEdit 0.52 / 0.57,
  SWE-bench 0.50 / 0.51 (stage 1 again). It does not turn into routing gain because the tiers agree on which tasks are
  hard: the gain is 0.4–7 % of the oracle headroom.
- Calibration: ECE pooled 0.012–0.034 (M1', isotonic; 0.025–0.029 raw), 0.015–0.030 (M2', temperature; 0.056–0.067 raw);
  ECE leave-one-source-out 0.12–0.24.

**Gate (declared in advance): not supported** for M1' (LOSO gain over the best non-learned baseline, the unfitted length
rank, −0.0021 [−0.0049, −0.0001]; within-source positive 4 of 4) and for M2' (+0.0018 [−0.0019, +0.0044]; 4 of 4).
Condition 2 passes, condition 1 fails for both.

**Sensitivity.** Equal tokens per task in every source: both fail (−0.0037 [−0.0065, −0.0019] and −0.0037
[−0.0064, −0.0014]). **Scheme B (1 / 5 $/M) — M1' passes the gate as written**: +0.0036 [+0.0025, +0.0041] over the best
non-learned baseline (here the mixture), 4 of 4 within. That pass must travel with two facts: a constant prior with no text
at all (the training mean per tier, with each source's own price ratios) gets +0.0048 under the same split, and the
fitted length model +0.0048; held out per source, M1' gains 0.0000–0.0013. The pass is a pooled-curve effect of
per-source price ratios, not text. M2' was trained on scheme-A labels only and is not evaluated under B.

## Leak ablation (M1' + one leaky field as its own feature block; 300 bootstraps)

| Field added | Pooled gain | LOSO gain | Low-tier AUROC inside the source (pooled CV) |
| --- | --- | --- | --- |
| none (final model) | +0.0271 | +0.0003 | CIE 0.52, BCB 0.62, LCB 0.76, SWE 0.50 |
| human difficulty tag (LCB, SWE) | +0.0277 | +0.0001 | LCB **0.87**, SWE **0.65** |
| constraints / follow-up section (LCB) | +0.0282 | +0.0003 | LCB 0.78 |
| starter code / the file to edit | +0.0276 | +0.0004 | CIE 0.66 |
| platform (LCB) | +0.0280 | +0.0005 | LCB 0.75 |
| reference solution | +0.0277 | +0.0009 | CIE **0.71**, BCB 0.68, SWE **0.65** |
| test code | +0.0269 | +0.0010 | CIE 0.59, BCB 0.65, SWE 0.58 |
| source id | +0.0271 | +0.0005 | – |
| all of the above | +0.0274 | +0.0048 [+0.0005, +0.0095] | CIE 0.65, BCB 0.70, LCB 0.87, SWE 0.72 |

The owner's worry is right for **accuracy**: a difficulty tag lifts LiveCodeBench's AUROC from 0.76 to 0.87 and the gold
patch lifts SWE-bench's from 0.50 to 0.65 — a model trained with them would report "difficulty prediction" that a router
cannot have. Even so the leaks buy almost no routing gain (≤ 0.001 pooled), for the same reason as the clean text: tiers
agree on hardness. The source-id feature adds nothing pooled because the text already identifies the source. The
final model's features are `title`, `brief`, `tools`, `depth` (`stage6_features.FEATURE_FIELDS`; a test asserts the list
and that scrambling every leak column changes no feature); constraints and BigCodeBench starter code are stripped.

## Probe: 60 hand-written delegation briefs (sanity probe, not evidence of solved rate)

| Scorer | Spearman(predicted difficulty, a-priori band) | Tier at τ = 0.5 equals band | Mean p(low) easy / medium / hard |
| --- | --- | --- | --- |
| M2' (int8 ONNX) | **0.59** | 34 of 60 (easy → low 11/20; hard → high 20/20; medium → high 17/20) | 0.48 / 0.33 / 0.28 |
| M1' | 0.30 | 22 of 60 (everything → high) | 0.39 / 0.37 / 0.36 |
| length only (fitted) | **−0.93** (longer brief → predicted easier) | 20 of 60 | 0.39 / 0.41 / 0.41 |
| router text rule | 0.40 (band vs band) | 29 of 60 (easy 19/20 right; hard → low 10/20) | – |

M2' orders realistic briefs in the right direction; its "hard → high" is partly the rule's fallback (no tier reaches
0.5 on most hard briefs). The fitted length model is inverted on briefs: across benchmarks long statements (LiveCodeBench,
SWE-bench) were solved more often than short ones (BigCodeBench, CanItEdit), so on briefs it calls the long hard ones easy —
the between-source confound in its plainest form. Worst misses of M2': "Add a constant MAX_RETRIES = 3 …" scored hardest
of the easy briefs (p_low 0.20); "Move the monorepo build from webpack to vite …" easiest of the hard (0.38).

## M2' artefacts

`models/m2_delegation.onnx` (int8, per-channel dynamic quantisation, 23.0 MB; fp32 would be 90.4 MB; built by
`make stage6-m2`, gitignored, not shipped), `models/m2_delegation_tokenizer/`, `models/m2_delegation.json`, reference scorer `src/routerml/stage6_score.py`
(onnxruntime + tokenizers only). 22.7 M parameters; final training 1 116 s on 4 CPUs (each CV fold 9–19 min). Parity
against PyTorch on 100 texts: fp32 max |Δp| 3e-7; int8 max 0.051, mean 0.010, same tier at τ = 0.5 for 96 of 100
(a first per-tensor int8 export moved p by up to 0.25 and was replaced). CPU latency, one thread, tokenisation included:
short brief p50 2.7 ms / p99 4.6 ms (int8), 5.6 / 6.4 ms (fp32); a 256-token brief 52 / 68 ms (int8), 74 / 90 ms (fp32) —
above the design's 20 ms for long briefs. Exported as an artefact; **not proposed for the router** (the gate failed).

## What the thesis can and cannot claim after stage 6

- **Cannot:** that a text model trained on public benchmarks predicts the cheapest sufficient tier of a delegated task.
  Pooled numbers that look like it are benchmark identity; leave-one-benchmark-out they vanish or reverse.
- **Can:** (1) the decomposition — pooled gain = source identity, with the source-id-only and length-only baselines that
  expose it; (2) the leak result, with numbers: difficulty tags and gold patches inflate accuracy (AUROC +0.11 to +0.19)
  while adding no routing value; (3) inside a benchmark with a real difficulty gradient in its wording (LiveCodeBench)
  the text ranks difficulty (AUROC 0.76–0.78), yet routing gains only 5–6 % of the oracle headroom because tiers agree
  on what is hard; (4) price tiers are not ability tiers (reasoning mid-price models beat the high tier on
  LiveCodeBench); (5) the probe shows M2' orders hand-written briefs sensibly (Spearman 0.59) — a hint that own-run labels
  on real briefs are worth collecting, not evidence.
- **Qualifications that travel with every number:** one public outcome table per source (several samples only for
  LiveCodeBench and CanItEdit); models of different years per source; open-weights prices are one host's; tokens per task
  for three sources are assumed (equal tokens tested: same verdict); scheme B flips the formal gate for M1' by a margin
  a text-free prior beats; Terminal-Bench 2 not included; public problems are not delegation briefs.
- **What would be needed:** own-run data — delegation briefs as the harness writes them, with the tier or model that ran
  each and an outcome. With the tier contrast this unreliable, a test of the text needs hundreds of briefs per tier, each
  run on at least two tiers.

# What six stages support, in one place

| Claim | Verdict |
| --- | --- |
| A model predicts the tier from the task's text | not supported (gain +0.000; ceiling about +0.017) |
| Across a wide range (edits to hard problems), the brief's text predicts the cheapest sufficient tier | not supported: pooled +0.027 is benchmark identity (source id alone +0.034); held out +0.0003 / +0.004, below a length model; within a benchmark 0.4–7 % of the oracle headroom |
| Leaky fields (difficulty tags, solutions, tests) explain "difficulty prediction" accuracy | supported for accuracy (AUROC +0.11 to +0.19); they add no routing gain |
| A learned cascade on the cheap model's early steps beats fixed tiers | not supported |
| Choosing the tier per step of a coding session saves cost | not supported under prompt caching (oracle 0.8 %) |
| A ladder filled by list price is a poor ladder | supported, large (0.310 against 0.686 reward per task at $1 per solved task) |
| A ladder read off a leaderboard of the same kind of work | the best simple policy; learning does not beat it |
| A ladder that learns online beats a leaderboard read from different work | supported when the top pick is wrong by more than 0.03–0.05 solved per task; not otherwise |
| Learning adapts to a new or degraded model | supported (tens of tasks) |
| The kind of work decides the tier | supported as a policy (81.1 against 63.6); recognising the kind is a lookup |
| A quality target can be held online with a stated risk | supported; not cheaper than an offline mixture with a margin |
