# One target per stage; `make all` rebuilds everything from the pinned revisions in src/routerml/config.py.
PY := .venv/bin/python
RUN := PYTHONPATH=src $(PY) -m

.PHONY: all venv fetch build features evaluate quick onnx figures test stage2 ceiling cascade traj-fetch trajectories steps bandit stage3 audit steps3 gencost triples stage4 ladder workload controller

all: fetch build features test evaluate onnx figures

venv:
	python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

fetch:      ## raw sources at pinned revisions -> data/
	$(RUN) routerml.fetch
build:      ## outcomes, models.csv, tiers, label + cost tables -> results/
	$(RUN) routerml.build
features:   ## text statistics, MiniLM embeddings
	$(RUN) routerml.features
evaluate:   ## M1 + baselines, 3 splits, bootstrap, ablations -> results/metrics.json (~30-40 min on 4 CPUs)
	$(RUN) routerml.evaluate
quick:      ## headline splits only -> results/metrics_quick.json (~5 min)
	$(RUN) routerml.evaluate --quick
onnx:       ## final M1 -> models/m1_joint.onnx + onnxruntime check
	$(RUN) routerml.export_onnx
figures:
	$(RUN) routerml.figures
test:
	$(PY) -m pytest -q

# ---- stage 2: where is the signal? (results/stage2_*.json, figures/stage2_*.png, results/stage2_report.txt)
stage2: ceiling cascade trajectories steps bandit

ceiling:    ## A: split-half reliability of labels and advantages, cross-fitted oracle (~30 s)
	$(RUN) routerml.ceiling
cascade:    ## B: post-hoc failure detector (api_calls, cost) + matrix-level cascade (~15 min)
	$(RUN) routerml.cascade
traj-fetch: ## B: mini-SWE-agent trajectories of 9 low-tier submissions from the public S3 bucket (~1.6 GB)
	$(RUN) routerml.traj_fetch
trajectories: traj-fetch ## B: early features at K = 5/10/20 steps, early detector, early cascade (~5 min)
	$(RUN) routerml.trajectories
steps:      ## B: TwinRouterBench step-level check, leave-one-task-out (~1 min)
	$(RUN) routerml.steps
bandit:     ## C: online adaptation with bandit feedback, 200 streams
	$(RUN) routerml.bandit

# ---- stage 3: ceiling audit, step-level cost-quality, concrete-model triples (results/stage3_*.json, results/stage3_report.txt)
stage3: audit steps3 gencost triples

audit:      ## 1: replay stage 2's 200 splits, exact area, symmetric ceiling; same-model run-to-run agreement (~20 s)
	$(RUN) routerml.stage3_audit
steps3:     ## 3: TwinRouterBench, all 970 steps, its own v2 metric and tokenizers (needs tiktoken; HF tokenizer download) (~25 min)
	$(RUN) routerml.stage3_steps
	$(RUN) routerml.stage3_steps_swe
gencost:    ## 3: cost estimate of generating more step labels with the benchmark's algorithm and prices (no API calls)
	$(RUN) routerml.stage3_gencost
triples:    ## 2: concrete cheap/mid/dear model triples (fetches haiku-4.5 trajectories, ~400 MB, if missing)
	$(RUN) routerml.traj_fetch 20260217_mini-v2.0.0_claude-4-5-haiku-high
	$(RUN) routerml.stage3_triples

# ---- stage 4: the three learned parts L1-L3 (results/stage4_*.json, figures/stage4_*.png, results/stage4_report.txt)
stage4: ladder controller workload

ladder:     ## L1: a ladder that learns itself - bandits over 33 concrete models, 3 stream orders x 200 streams (~3 min)
	$(RUN) routerml.stage4_ladder
controller: ## L3: quality controller (lower-confidence-bound) vs the offline mixture tuned on a held-out half (~3 min)
	$(RUN) routerml.stage4_controller
workload:   ## L2: workload classifier from the first request only + per-workload tier policy, TwinRouterBench metric (~3 min)
	$(RUN) routerml.stage4_workload
