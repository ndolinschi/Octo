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
| `results/` | small derived tables and every number in REPORT.md (`build.json`, `metrics.json`, `onnx_check.json`) |
| `figures/` | cost–quality curve, reliability diagrams, per-repository bars |
| `models/` | `m1_joint.onnx` (27 KB) and the LightGBM text dump |

Licences: SWE-bench/experiments states none (only derived 0/1 tables are kept here, with attribution);
SWE-bench Verified's card states none; LiteLLM's price table is MIT; all-MiniLM-L6-v2 is Apache-2.0;
TwinRouterBench is Apache-2.0 (only inspected, not used for training).
