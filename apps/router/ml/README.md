# Learned router: data and the first model (M1)

Steps 1 and 2 of [`docs/superpowers/specs/2026-11-13-learned-router-design.md`](../../../docs/superpowers/specs/2026-11-13-learned-router-design.md):
the task × tier label table from public data, routing-time features, and M1 (LightGBM) against baselines.
Results, limits and corrections to the design: [`REPORT.md`](./REPORT.md).

## Reproduce

Python 3.13, 4 CPUs, no GPU. Every source is pinned in [`src/routerml/config.py`](./src/routerml/config.py).

```bash
cd apps/router/ml
make venv        # python3 -m venv .venv && pip install -r requirements.txt
make fetch       # SWE-bench Verified (HF revision), SWE-bench/experiments (commit), LiteLLM prices (commit),
                 # OpenRouter catalogue snapshot, all-MiniLM-L6-v2 ONNX  -> data/ (gitignored)
make build       # outcomes, results/models.csv, tiers under 3 cut schemes, label + cost tables
make features    # text statistics, MiniLM embeddings (CPU, ~30 s)
make test        # leak test, label-table invariants, split disjointness
make evaluate    # M1 + baselines on LORO / time / grouped 4-fold, bootstrap CIs, ablations (~30-40 min)
make onnx        # final M1 -> models/m1_joint.onnx, onnxruntime check on 100 rows
make figures     # figures/*.png
make all         # all of the above in order
```

`make quick` runs only the three headline splits (about 5 minutes) into `results/metrics_quick.json`.

Stage 2 (where the signal is; report: `results/stage2_report.txt`; `make stage2` runs all five):

- `make ceiling`: split-half reliability of the soft labels and of tier advantages; oracle built on one half of the submissions, scored on the other.
- `make cascade`: post-hoc failure detector of a cheap run (api_calls, cost) and the cheap-then-escalate cascade on the matrix.
- `make trajectories`: fetches 9 low-tier mini-SWE-agent trajectory sets (~1.6 GB, public S3) and tests an early detector after K = 5/10/20 steps.
- `make steps`: TwinRouterBench's 336 SWE steps, step-time features -> collapsed target tier, leave-one-task-out.
- `make bandit`: online tier choice per repository with bandit feedback (Thompson, UCB, empirical-Bayes start, Lagrangian), 200 streams.

Stage 3 (checks; report: `results/stage3_report.txt`; `make stage3` runs all four):

- `make audit`: replays stage 2's ceiling splits, exact area, symmetric ceiling definition; run-to-run agreement of the same model.
- `make steps3`: TwinRouterBench's whole static bank (970 steps, 5 workloads) scored with the benchmark's own v2 metric; LOTO and leave-one-workload-out.
- `make gencost`: what generating more step labels would cost with the benchmark's algorithm and prices (estimate; no API calls).
- `make triples`: concrete cheap/mid/dear model triples: outcome tables, noise-bounded oracle, text and early-trajectory detectors, honest cascade.

Stage 4 (the three learned parts; report: `results/stage4_report.txt`; `make stage4` runs all three):

- `make ladder`: L1, a ladder that learns itself: cost-aware bandits over 33 concrete models (one run per model), list-price and leaderboard ladders, constrained objective, a new / degrading model mid-stream, a leaderboard from a held-out half.
- `make controller`: L3, a quality controller (lower confidence bound on the stream's quality ratio) against the offline mixture tuned on a held-out half; tiers and models (~10 min).
- `make workload`: L2, the workload recognised from the first request only (TwinRouterBench), the per-workload tier policy on the benchmark's own metric, leave-one-workload-out with a safe-tier fallback.

Stage 5 (cross-benchmark transfer; report: `results/stage5_report.txt`; `make stage5` = `make xbench-fetch xbench`):

- `make xbench-fetch`: Terminal-Bench 2 leaderboard (HF `harborframework/terminal-bench-2-leaderboard` at the revision in `config.py`, Apache-2.0): job summaries of all 75 systems and per-trial `result.json` (cost) of the systems whose model matches the Verified core; SWE-bench Multilingual per-instance lists from the pinned experiments clone.
- `make xbench`: does the Verified ranking of models transfer to Terminal-Bench 2 (Terminus 2 scaffold; all scaffolds pooled) and to Multilingual; the leaderboard ladder read off Verified against bandits (flat, and with a Verified prior of strength n0 = 5 / 20 / 50) on the target's tasks; a held-out-half target leaderboard; the reverse control; a break-even simulation with a perturbed leaderboard (`src/routerml/{xbench_fetch,xbench_data,stage5}.py`, `tests/test_stage5.py`).

Note: the OpenRouter catalogue has no revision. `fetch` keeps the first snapshot it downloads
(2026-11-13 for the numbers in REPORT.md); a fresh clone gets today's catalogue, which can change the
prices of the 9 models sourced from it (`results/models.csv`, column `source`).

## Layout

| Path | What |
| --- | --- |
| `src/routerml/fetch.py` | raw sources at pinned revisions into `data/` |
| `src/routerml/build.py` | submissions, model → price → tier, label table, cost table |
| `src/routerml/features.py` | routing-time features; `routing_view` is the only door to task fields |
| `src/routerml/evaluate.py` | M1, baselines, splits, metrics, bootstrap |
| `src/routerml/export_onnx.py` | ONNX export + parity check |
| `src/routerml/figures.py` | figures |
| `tests/test_pipeline.py` | pytest suite |
| `src/routerml/{stage2,ceiling,cascade,traj_fetch,trajectories,steps,bandit}.py`, `tests/test_stage2.py` | stage 2 |
| `src/routerml/stage4_{common,ladder,controller,workload}.py`, `tests/test_stage4.py` | stage 4 (L1-L3) |
| `results/` | small derived tables and every number in REPORT.md (`build.json`, `metrics.json`, `onnx_check.json`) |
| `figures/` | cost–quality curve, reliability diagrams, per-repository bars |
| `models/` | `m1_joint.onnx` (27 KB) and the LightGBM text dump |

Licences: SWE-bench/experiments states none (only derived 0/1 tables are kept here, with attribution);
SWE-bench Verified's card states none; LiteLLM's price table is MIT; all-MiniLM-L6-v2 is Apache-2.0;
TwinRouterBench is Apache-2.0 (only inspected, not used for training).
