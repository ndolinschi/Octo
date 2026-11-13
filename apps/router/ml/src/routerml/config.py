"""Pinned sources, paths and seeds. Every derived number traces back to these constants."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # apps/router/ml
DATA = ROOT / "data"
RESULTS = ROOT / "results"
FIGURES = ROOT / "figures"

# Task metadata: Hugging Face dataset revision (commit sha of the dataset repo).
HF_DATASET = "princeton-nlp/SWE-bench_Verified"
HF_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a"
HF_FILE = "data/test-00000-of-00001.parquet"

# Outcomes: SWE-bench/experiments, commit read with `git log -1` on the clone (2026-09-03).
EXPERIMENTS_URL = "https://github.com/SWE-bench/experiments"
EXPERIMENTS_COMMIT = "40f164d5b8f1d249bf95a6df8b74b577fd8e519d"

# Prices: LiteLLM's price table (the table mini-SWE-agent uses to compute its per-instance cost),
# pinned to the main-branch commit read on 2026-11-13, plus the OpenRouter catalogue snapshot
# fetched the same day (the catalogue has no revision; the snapshot is kept in data/).
LITELLM_COMMIT = "46716fad56505ae5a0dc118a64da7a1bd6061ea3"
LITELLM_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/"
    f"{LITELLM_COMMIT}/model_prices_and_context_window.json"
)
OPENROUTER_URL = "https://openrouter.ai/api/v1/models"
PRICES_FETCHED = "2026-11-13"

# Sentence embedding model (CPU, ONNX export shipped in the model repo).
EMB_REPO = "sentence-transformers/all-MiniLM-L6-v2"
EMB_REVISION = "main"  # resolved sha recorded in data/embeddings_meta.json at fetch time

TWINROUTERBENCH_URL = "https://github.com/CommonstackAI/TwinRouterBench"

TIERS = ("low", "mid", "high")
SEED = 20261113
N_BOOT = 1000

# Fields that are never allowed to reach the feature matrix.
FORBIDDEN_FIELDS = (
    "patch",
    "test_patch",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "difficulty",
    "hints_text",
)
# Fields that may be used at routing time. `repo` is used only for grouping splits, never as a feature.
ROUTING_FIELDS = ("instance_id", "problem_statement", "repo", "base_commit", "created_at", "version")

# ---- stage 5 (cross-benchmark transfer). Revisions read on 2026-11-13.
# Terminal-Bench 2 leaderboard (Apache-2.0); commit sha of the HF dataset repo.
TB2_REPO = "harborframework/terminal-bench-2-leaderboard"
TB2_REVISION = "572b2614be2c0cb2527e14f5b1e4026f1072e6c1"
# SWE-bench Multilingual task list (MIT); outcomes come from SWE-bench/experiments at EXPERIMENTS_COMMIT.
ML_DATASET = "SWE-bench/SWE-bench_Multilingual"
ML_REVISION = "846e647b9f33c0b51b739d005d13d85493c9af09"
ML_FILE = "data/test-00000-of-00001.parquet"
