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

# What five stages support, in one place

| Claim | Verdict |
| --- | --- |
| A model predicts the tier from the task's text | not supported (gain +0.000; ceiling about +0.017) |
| A learned cascade on the cheap model's early steps beats fixed tiers | not supported |
| Choosing the tier per step of a coding session saves cost | not supported under prompt caching (oracle 0.8 %) |
| A ladder filled by list price is a poor ladder | supported, large (0.310 against 0.686 reward per task at $1 per solved task) |
| A ladder read off a leaderboard of the same kind of work | the best simple policy; learning does not beat it |
| A ladder that learns online beats a leaderboard read from different work | supported when the top pick is wrong by more than 0.03–0.05 solved per task; not otherwise |
| Learning adapts to a new or degraded model | supported (tens of tasks) |
| The kind of work decides the tier | supported as a policy (81.1 against 63.6); recognising the kind is a lookup |
| A quality target can be held online with a stated risk | supported; not cheaper than an offline mixture with a margin |
