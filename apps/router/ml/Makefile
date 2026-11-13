# One target per stage; `make all` rebuilds everything from the pinned revisions in src/routerml/config.py.
PY := .venv/bin/python
RUN := PYTHONPATH=src $(PY) -m

.PHONY: all venv fetch build features evaluate quick onnx figures test

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
