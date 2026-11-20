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

# ---- stage 6 (delegation briefs: does the text predict the cheapest sufficient tier across a wide range?).
# Revisions read on 2026-11-20. Labels are model outcomes only; human difficulty tags are leak-test material.
S6_DATA = DATA / "stage6"
# LiveCodeBench per-problem pass@1 of 28 models (the leaderboard site's repository, build/performances_generation.json).
LCB_SITE_RAW = "https://raw.githubusercontent.com/LiveCodeBench/livecodebench.github.io"
LCB_SITE_COMMIT = "f186ab5041d6b768733b8ae8145151c867942134"
LCB_PERF_FILE = "build/performances_generation.json"
# LiveCodeBench problem statements (HF, licence field "cc"); the jsonl files carry the hidden tests (4.5 GB in all),
# so they are streamed and only the statement fields are kept.
LCB_HF = "livecodebench/code_generation_lite"
LCB_HF_REVISION = "0fe84c3912ea0c4d4a78037083943e8f0c4dd505"
LCB_HF_FILES = ("test.jsonl", "test2.jsonl", "test3.jsonl", "test4.jsonl", "test5.jsonl", "test6.jsonl")
# BigCodeBench (Apache-2.0) tasks and the per-task x per-model 0/1 table of the Instruct split (no licence stated).
BCB_HF = "bigcode/bigcodebench"
BCB_HF_REVISION = "b74c0d0bf70d2c0bc459be537895cca163007f1a"
BCB_HF_FILE = "data/v0.1.4-00000-of-00001.parquet"
BCB_PERF_HF = "bigcode/bigcodebench-perf"
BCB_PERF_REVISION = "249b3054d25ae61746e8fbe014782ebe4526f844"
BCB_PERF_FILE = "data/instruct-00000-of-00001.parquet"
# CanItEdit (MIT): instructional code edits; 2 834 tested predictions of 9 models x 3 runs (MIT).
CIE_HF = "nuprl/CanItEdit"
CIE_HF_REVISION = "3c07f38b1f9385f3214fcea94d4664c79df0d36a"
CIE_HF_FILE = "data/test-00000-of-00001.parquet"
CIE_PRED_HF = "WhyDoYouCare/CanItEditPredictions"
CIE_PRED_REVISION = "948196786bf52d272e4b0a4b3b09bf338a317940"
CIE_PRED_FILE = "canitedit.jsonl"
# Sentence encoder for M1' and the encoder fine-tuned as M2' (Apache-2.0), pinned by commit.
S6_ENCODER = "sentence-transformers/all-MiniLM-L6-v2"
S6_ENCODER_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
S6_SOURCES = ("canitedit", "bigcodebench", "livecodebench", "swebench_verified")
S6_CUTS = {"A": (0.8, 3.4375), "B": (1.0, 5.0)}  # stage 1's scheme A (headline) and B, $/M blended 3:1
