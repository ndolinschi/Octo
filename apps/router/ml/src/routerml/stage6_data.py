"""Stage 6 data: four sources -> one task table (brief + leak fields), a long outcome table, tiers, soft labels, costs.

Sources (pinned in config.py; fetched by stage6_fetch):
  canitedit          105 instructional edits of one Python file; 9 models x 3 runs, tested (2 834 predictions).
  bigcodebench       1 140 library-using function tasks (Instruct split); 126 models, greedy 0/1.
  livecodebench      1 055 competitive-programming problems; 28 models, pass@1 over several samples.
  swebench_verified  500 repository issues; stage 1's 39 mini-SWE-agent submissions (34 models), 0/1.

Labels are model outcomes only. A model enters a tier by its blended list price (3:1) from the pinned LiteLLM table
(the alias table below says which key; unpriced models are excluded and listed). Soft label per (task, tier) = mean
outcome over the tier's models; cheapest sufficient tier = the lowest tier with soft label >= 0.5, else "none".

The brief (`title`, `brief`) is what a router would see at delegation time. Fields that would leak (difficulty tags,
constraints, starter code, reference solutions, tests, platform) are kept in `leak_*` columns for the ablation only;
`stage6_features.delegation_view` is the only door from this table to a feature.
"""

from __future__ import annotations

import json
import re

import numpy as np
import pandas as pd

from . import config as C

D = C.S6_DATA
TIERS = C.TIERS
SOURCES = C.S6_SOURCES
FW = "fireworks_ai/accounts/fireworks/models/"

# Model name in the source -> LiteLLM key at C.LITELLM_COMMIT (first-party key where the table has one; otherwise one
# named host, said in the note). Names absent here are unpriced and excluded.
PRICE_KEYS: dict[str, dict[str, tuple[str, str]]] = {
    "livecodebench": {
        "DeepSeek-V3": ("deepseek/deepseek-v3", ""),
        "GPT-4-Turbo-2024-04-09": ("gpt-4-turbo-2024-04-09", ""),
        "GPT-4O-2024-08-06": ("gpt-4o-2024-08-06", ""),
        "GPT-4O-mini-2024-07-18": ("gpt-4o-mini-2024-07-18", ""),
        "O3-Mini-2025-01-31 (Low)": ("o3-mini-2025-01-31", "effort variant; same list price"),
        "O3-Mini-2025-01-31 (Med)": ("o3-mini-2025-01-31", "effort variant; same list price"),
        "O3-Mini-2025-01-31 (High)": ("o3-mini-2025-01-31", "effort variant; same list price"),
        "O4-Mini (Low)": ("o4-mini-2025-04-16", "effort variant; same list price"),
        "O4-Mini (Medium)": ("o4-mini-2025-04-16", "effort variant; same list price"),
        "O4-Mini (High)": ("o4-mini-2025-04-16", "effort variant; same list price"),
        "O3 (High)": ("o3-2025-04-16", "price after the June 2025 cut"),
        "Claude-3.5-Sonnet-20241022": ("anthropic.claude-3-5-sonnet-20241022-v2:0", "Bedrock key; Anthropic list price"),
        "Claude-3-Haiku": ("vertex_ai/claude-3-haiku@20240307", "Vertex key; Anthropic list price"),
        "Claude-Sonnet-4": ("anthropic.claude-sonnet-4-20250514-v1:0", "Bedrock key; Anthropic list price"),
        "Claude-Sonnet-4 (Thinking)": ("anthropic.claude-sonnet-4-20250514-v1:0", "thinking variant; same list price"),
        "Claude-Opus-4": ("anthropic.claude-opus-4-20250514-v1:0", "Bedrock key; Anthropic list price"),
        "Claude-Opus-4 (Thinking)": ("anthropic.claude-opus-4-20250514-v1:0", "thinking variant; same list price"),
        "Gemini-2.5-Pro-05-06": ("gemini/gemini-2.5-pro", "GA price stands in for the preview"),
        "Gemini-2.5-Pro-06-05": ("gemini/gemini-2.5-pro", "GA price stands in for the preview"),
        "Gemini-2.5-Flash-04-17": ("gemini/gemini-2.5-flash", "GA price stands in for the preview"),
        "Gemini-2.5-Flash-05-20": ("gemini/gemini-2.5-flash", "GA price stands in for the preview"),
        "Qwen3-235B-A22B": (FW + "qwen3-235b-a22b", "open weights; Fireworks price"),
        "DeepSeek-R1-0528": ("deepseek/deepseek-r1", "R1 list price"),
        "Grok-3-Mini (High)": ("vercel_ai_gateway/xai/grok-3-mini", "gateway key; xAI list price"),
    },
    "bigcodebench": {
        "GPT-3.5-Turbo-0125": ("gpt-3.5-turbo-0125", ""),
        "GPT-4o-2024-05-13": ("gpt-4o-2024-05-13", ""),
        "GPT-4o-2024-11-20": ("gpt-4o-2024-11-20", ""),
        "GPT-4-Turbo-2024-04-09": ("gpt-4-turbo-2024-04-09", ""),
        "GPT-4-0613": ("gpt-4-0613", ""),
        "GPT-4o-mini-2024-07-18": ("gpt-4o-mini-2024-07-18", ""),
        "GPT-4.1-Mini-2025-04-14": ("gpt-4.1-mini-2025-04-14", ""),
        "Claude-3-Haiku-20240307": ("vertex_ai/claude-3-haiku@20240307", "Vertex key; Anthropic list price"),
        "Claude-3-Sonnet-20240229": ("vertex_ai/claude-3-sonnet@20240229", "Vertex key; Anthropic list price"),
        "Claude-3-Opus-20240229": ("anthropic.claude-3-opus-20240229-v1:0", "Bedrock key; Anthropic list price"),
        "Claude-3.5-Sonnet-20240620": ("anthropic.claude-3-5-sonnet-20240620-v1:0", "Bedrock key"),
        "Claude-3.5-Sonnet-20241022": ("anthropic.claude-3-5-sonnet-20241022-v2:0", "Bedrock key"),
        "Claude-3.5-Haiku-20241022": ("anthropic.claude-3-5-haiku-20241022-v1:0", "Bedrock key"),
        "Mistral-Large-2402": ("mistral.mistral-large-2402-v1:0", "Bedrock key"),
        "Mistral-Small-2402": ("mistral.mistral-small-2402-v1:0", "Bedrock key"),
        "Mixtral-8x22B-Instruct": (FW + "mixtral-8x22b-instruct", "open weights; Fireworks price"),
        "Codestral-22B-v0.1": ("mistral/codestral-latest", "the 2405 key is priced 0 (free tier); 'latest' list price"),
        "Codestral-Mamba": ("mistral/codestral-mamba-latest", ""),
        "Command R+": ("command-r-plus-08-2024", "08-2024 price stands in for the first release"),
        "C4AI-Command-R-08-2024": ("command-r-08-2024", ""),
        "DeepSeek-V3": ("deepseek/deepseek-v3", ""),
        "DeepSeek-Coder-V2-Instruct": (FW + "deepseek-coder-v2-instruct", "open weights; Fireworks price"),
        "DeepSeek-Coder-33B-Instruct": (FW + "deepseek-coder-33b-instruct", "open weights; Fireworks price"),
        "Llama-3-70B-Instruct": (FW + "llama-v3-70b-instruct", "open weights; Fireworks price"),
        "Llama-3-8B-Instruct": (FW + "llama-v3-8b-instruct-hf", "open weights; Fireworks price"),
        "Llama-3.1-70B-Instruct": (FW + "llama-v3p1-70b-instruct", "open weights; Fireworks price"),
        "Llama-3.1-8B-Instruct": (FW + "llama-v3p1-8b-instruct", "open weights; Fireworks price"),
        "Llama-3.3-70B-Instruct": (FW + "llama-v3p3-70b-instruct", "open weights; Fireworks price"),
        "Llama-3.2-1B-Instruct": ("novita/meta-llama/llama-3.2-1b-instruct", "open weights; Novita price"),
        "Llama-3.2-3B-Instruct": ("novita/meta-llama/llama-3.2-3b-instruct", "open weights; Novita price"),
        "Llama-4-Maverick": (FW + "llama4-maverick-instruct-basic", "open weights; Fireworks price"),
        "Llama-3.1-Nemotron-70B-Instruct": ("lambda_ai/llama3.1-nemotron-70b-instruct-fp8", "Lambda price"),
        "Qwen2.5-Coder-32B-Instruct": (FW + "qwen2p5-coder-32b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-Coder-14B-Instruct": (FW + "qwen2p5-coder-14b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-Coder-7B-Instruct": (FW + "qwen2p5-coder-7b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-Coder-1.5B-Instruct": (FW + "qwen2p5-coder-1p5b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-72B-Instruct": (FW + "qwen2p5-72b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-32B-Instruct": (FW + "qwen2p5-32b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-7B-Instruct": (FW + "qwen2p5-7b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-1.5B-Instruct": (FW + "qwen2p5-1p5b-instruct", "open weights; Fireworks price"),
        "Qwen2.5-0.5B-Instruct": (FW + "qwen2p5-0p5b-instruct", "open weights; Fireworks price"),
        "Qwen2-72B-Chat": (FW + "qwen2-72b-instruct", "open weights; Fireworks price"),
        "Qwen2-7B-Instruct": (FW + "qwen2-7b-instruct", "open weights; Fireworks price"),
        "Qwen1.5-72B-Chat": (FW + "qwen1p5-72b-chat", "open weights; Fireworks price"),
        "QwQ-32B-Preview": (FW + "qwen-qwq-32b-preview", "open weights; Fireworks price"),
        "DeepSeek-R1-Distill-Llama-70B": (FW + "deepseek-r1-distill-llama-70b", "open weights; Fireworks price"),
        "DeepSeek-R1-Distill-Llama-8B": (FW + "deepseek-r1-distill-llama-8b", "open weights; Fireworks price"),
        "DeepSeek-R1-Distill-Qwen-14B": (FW + "deepseek-r1-distill-qwen-14b", "open weights; Fireworks price"),
        "Yi-Large": (FW + "yi-large", "Fireworks price"),
        "Phi-4": ("deepinfra/microsoft/phi-4", "open weights; DeepInfra price"),
        "Phi-3-Mini-128K-Instruct": (FW + "phi-3-mini-128k-instruct", "open weights; Fireworks price"),
        "Gemma-2-9B-Instruct": (FW + "gemma2-9b-it", "open weights; Fireworks price"),
        "Gemma-2-27B-Instruct": ("gemini/gemini-gemma-2-27b-it", "Gemini API price"),
        "Granite-3.0-8B-Instruct": ("watsonx/ibm/granite-3-8b-instruct", "watsonx price"),
        "CodeLlama-34B-Instruct": ("perplexity/codellama-34b-instruct", "Perplexity price"),
        "CodeLlama-70B-Instruct": ("perplexity/codellama-70b-instruct", "Perplexity price"),
    },
    "canitedit": {
        "claude-sonnet-4": ("anthropic.claude-sonnet-4-20250514-v1:0", "Bedrock key; Anthropic list price"),
        "gpt-4o-2024-11-20": ("gpt-4o-2024-11-20", ""),
        "gpt-4o-mini-2024-07-18": ("gpt-4o-mini-2024-07-18", ""),
        "gpt-4.1-nano-2025-04-14": ("gpt-4.1-nano-2025-04-14", ""),
        "gemini-2.5-flash": ("gemini/gemini-2.5-flash", ""),
        "local_qwen2p5_coder_3b": (FW + "qwen2p5-coder-3b-instruct", "run locally by the authors; Fireworks price"),
        "local_qwen2p5_coder_7b": (FW + "qwen2p5-coder-7b-instruct", "run locally by the authors; Fireworks price"),
        "local_deepseek_coder_instruct_6p7b": ("llamagate/deepseek-coder-6.7b", "run locally; LlamaGate price"),
        "local_deepseek_coder_instruct_1p3b": (FW + "deepseek-coder-1b-base", "run locally; price of the 1B base"),
    },
}

# Typical tokens per task (input + output) for the cost model: cost(task, tier) = tier's mean blended price x tokens.
# Declared, not measured, except SWE-bench (implied by mini-SWE-agent's measured per-instance cost, see swe_tokens()).
TOKENS = {"canitedit": 2_000, "bigcodebench": 2_000, "livecodebench": 10_000}


def blended(i: float, o: float) -> float:
    return (3 * i + o) / 4


def assign(price: float, cuts: tuple[float, float]) -> str:
    return "low" if price < cuts[0] else ("mid" if price < cuts[1] else "high")


def _litellm() -> dict:
    return json.loads((D / "litellm_prices.json").read_text())


def price_rows(source: str, names: list[str]) -> pd.DataFrame:
    lit, rows = _litellm(), []
    for n in names:
        key, note = PRICE_KEYS[source].get(n, (None, "not priced: excluded"))
        e = lit.get(key) if key else None
        if e is None or e.get("input_cost_per_token") is None:
            rows.append(dict(source=source, model=n, key=key, blended_per_m=np.nan, note=note or "key missing"))
            continue
        i, o = e["input_cost_per_token"] * 1e6, (e.get("output_cost_per_token") or 0) * 1e6
        rows.append(dict(source=source, model=n, key=key, input_per_m=i, output_per_m=o, blended_per_m=blended(i, o), note=note))
    df = pd.DataFrame(rows)
    for s, cuts in C.S6_CUTS.items():
        df[f"tier_{s}"] = [assign(p, cuts) if np.isfinite(p) else None for p in df.blended_per_m]
    return df


# ------------------------------------------------------------------------------------------------ brief cleaning
LC_CONSTRAINTS = re.compile(r"\n\s*Constraints:?\s*\n.*", re.S)  # LeetCode: constraints (and any follow-up) at the end
AC_CONSTRAINTS = re.compile(r"\n\s*Constraints\s*\n(.*?)(?=\n\s*(?:Input|Output|Sample Input)|\Z)", re.S)  # AtCoder
FOLLOW_UP = re.compile(r"\n\s*Follow[- ]?up:?.*", re.S | re.I)
CODE_BLOCK = re.compile(r"You should write self-contained code starting with:?\s*```.*?```", re.S)


def split_lcb(text: str, platform: str) -> tuple[str, str]:
    """(statement without constraints / follow-up, the removed part)."""
    text = text or ""
    removed = []
    if platform == "leetcode":
        m = LC_CONSTRAINTS.search(text)
        if m:
            removed.append(m.group(0))
            text = text[: m.start()]
        m = FOLLOW_UP.search(text)
        if m:
            removed.append(m.group(0))
            text = text[: m.start()]
    elif platform == "atcoder":
        m = AC_CONSTRAINTS.search(text)
        if m:
            removed.append(m.group(1))
            text = text[: m.start()] + text[m.end() :]
    return text.strip(), "\n".join(removed).strip()


def split_bcb(prompt: str) -> tuple[str, str]:
    m = CODE_BLOCK.search(prompt or "")
    if not m:
        return (prompt or "").strip(), ""
    return (prompt[: m.start()] + prompt[m.end() :]).strip(), m.group(0)


# ------------------------------------------------------------------------------------------------ sources
def load_lcb() -> tuple[pd.DataFrame, pd.DataFrame]:
    perf = json.loads((D / "lcb_performances_generation.json").read_text())["performances"]
    out = pd.DataFrame(perf).rename(columns={"question_id": "task_id"})
    out["score"] = out["pass@1"].astype(float) / 100.0
    probs = [json.loads(line) for line in (D / "lcb_problems.jsonl").read_text().splitlines()]
    p = pd.DataFrame(probs).drop_duplicates("question_id", keep="last").set_index("question_id")
    ids = sorted(set(out.task_id) & set(p.index))
    rows = []
    for q in ids:
        r = p.loc[q]
        brief, cons = split_lcb(r.question_content, r.platform)
        rows.append(
            dict(
                source="livecodebench",
                task_id=q,
                group=f"lcb:{r.platform}:{r.contest_id}",
                title=r.question_title or "",
                brief=brief,
                created=str(r.contest_date)[:10],
                leak_difficulty=r.difficulty,
                leak_constraints=cons,
                leak_starter=r.starter_code or "",
                leak_platform=r.platform,
                leak_solution="",
                leak_tests="",
                leak_n_public_tests=int(r.n_public_tests),
            )
        )
    tasks = pd.DataFrame(rows)
    out = out[out.task_id.isin(ids)][["task_id", "model", "score"]].assign(source="livecodebench")
    return tasks, out


def load_bcb() -> tuple[pd.DataFrame, pd.DataFrame]:
    t = pd.read_parquet(D / "bcb_tasks.parquet")
    perf = pd.read_parquet(D / "bcb_perf_instruct.parquet")
    long = perf.melt(id_vars="Model", var_name="task_id", value_name="score").rename(columns={"Model": "model"})
    long["score"] = long.score.astype(float)
    rows = []
    for r in t.itertuples():
        brief, starter = split_bcb(r.instruct_prompt)
        rows.append(
            dict(
                source="bigcodebench",
                task_id=r.task_id,
                group=f"bcb:{r.task_id}",
                title="",
                brief=brief,
                created="",
                leak_difficulty=None,
                leak_constraints="",
                leak_starter=starter,
                leak_platform="",
                leak_solution=r.canonical_solution,
                leak_tests=r.test,
                leak_libs=str(r.libs),
                leak_n_public_tests=0,
            )
        )
    tasks = pd.DataFrame(rows)
    long = long[long.task_id.isin(set(tasks.task_id))].assign(source="bigcodebench")
    return tasks, long


def load_cie() -> tuple[pd.DataFrame, pd.DataFrame]:
    t = pd.read_parquet(D / "cie_tasks.parquet")
    preds = []
    for line in (D / "cie_predictions.jsonl").read_text().splitlines():
        r = json.loads(line)
        m = r["metadata"] if isinstance(r["metadata"], dict) else json.loads(r["metadata"].replace("'", '"'))
        g = re.search(r"predictions/(.+)\.run_(\d+)\.jsonl", m["preds_path"])
        preds.append(dict(task_id=str(m["dataset_sample"]), model=g.group(1), run=int(g.group(2)), score=float(r["passes_tests"])))
    p = pd.DataFrame(preds)
    long = p.groupby(["task_id", "model"], as_index=False).score.mean().assign(source="canitedit")
    rows = []
    for r in t.itertuples():
        rows.append(
            dict(
                source="canitedit",
                task_id=str(r.id),
                group=f"cie:{r.id}",
                title=r.name.replace("_", " "),
                brief=r.instruction_lazy,
                brief_descriptive=r.instruction_descriptive,
                created="",
                leak_difficulty=None,
                leak_constraints="",
                leak_starter=r.before,  # the file to edit: a sub-agent would read it, the router would not see it
                leak_platform="",
                leak_solution=r.after,
                leak_tests=r.tests,
                leak_n_public_tests=0,
            )
        )
    tasks = pd.DataFrame(rows)
    long = long[long.task_id.isin(set(tasks.task_id))]
    return tasks, long


def load_swe() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    v = pd.read_parquet(D / "swebench_verified.parquet")
    subs = pd.read_csv(C.RESULTS / "submissions.csv")
    subs = subs[subs.in_core]
    oc = pd.read_csv(C.RESULTS / "outcomes_core.csv.gz")
    oc = oc[oc.submission.isin(set(subs.submission))].merge(subs[["submission", "canon"]], on="submission")
    long = oc.rename(columns={"instance_id": "task_id", "resolved": "score"})
    long["model"] = long["submission"]  # a submission is the unit (stage 1); several share a model
    rows = []
    for r in v.itertuples():
        rows.append(
            dict(
                source="swebench_verified",
                task_id=r.instance_id,
                group=f"swe:{r.repo}",
                title="",
                brief=r.problem_statement,
                created=str(r.created_at)[:10],
                leak_difficulty=r.difficulty,
                leak_constraints="",
                leak_starter="",
                leak_platform="",
                leak_solution=r.patch,
                leak_tests=r.test_patch,
                leak_hints=r.hints_text,
                leak_n_public_tests=0,
            )
        )
    tasks = pd.DataFrame(rows)
    return tasks, long[["task_id", "model", "score", "cost_usd", "canon"]].assign(source="swebench_verified"), subs


def swe_prices(subs: pd.DataFrame) -> pd.DataFrame:
    m = pd.read_csv(C.RESULTS / "models.csv").set_index("model")
    rows = []
    for s in subs.itertuples():
        bp = float(m.loc[s.canon, "blended_per_m"])
        rows.append(dict(source="swebench_verified", model=s.submission, key=s.canon, blended_per_m=bp, note="stage 1 models.csv"))
    df = pd.DataFrame(rows)
    for sch, cuts in C.S6_CUTS.items():
        df[f"tier_{sch}"] = [assign(p, cuts) for p in df.blended_per_m]
    return df


def swe_tokens(long: pd.DataFrame, prices: pd.DataFrame) -> float:
    """Tokens per task implied by mini-SWE-agent's measured cost: median over submissions of mean cost / blended price."""
    c = long.dropna(subset=["cost_usd"]).groupby("model").cost_usd.mean()
    p = prices.set_index("model").blended_per_m
    return float(np.median((c / p.reindex(c.index)) * 1e6))


# ------------------------------------------------------------------------------------------------ build
def build() -> dict:
    """Everything stage 6 needs, as one dict of DataFrames (cached in data/stage6/built.pkl? no: rebuilt, ~seconds)."""
    t_lcb, o_lcb = load_lcb()
    t_bcb, o_bcb = load_bcb()
    t_cie, o_cie = load_cie()
    t_swe, o_swe, subs = load_swe()
    prices = pd.concat(
        [
            price_rows("livecodebench", sorted(o_lcb.model.unique())),
            price_rows("bigcodebench", sorted(o_bcb.model.unique())),
            price_rows("canitedit", sorted(o_cie.model.unique())),
            swe_prices(subs),
        ],
        ignore_index=True,
    )
    tokens = dict(TOKENS, swebench_verified=swe_tokens(o_swe, prices[prices.source == "swebench_verified"]))
    tasks = pd.concat([t_cie, t_bcb, t_lcb, t_swe], ignore_index=True)
    for col in ("brief_descriptive", "leak_libs", "leak_hints"):
        tasks[col] = tasks[col].fillna("") if col in tasks else ""
    tasks["uid"] = tasks.source + "::" + tasks.task_id.astype(str)
    tasks["tools"] = [[] for _ in range(len(tasks))]  # public data has no tool list or depth: constant
    tasks["depth"] = 1
    outcomes = pd.concat([o_cie, o_bcb, o_lcb, o_swe[["task_id", "model", "score", "source"]]], ignore_index=True)
    outcomes["uid"] = outcomes.source + "::" + outcomes.task_id.astype(str)
    outcomes = outcomes.merge(prices[["source", "model", "blended_per_m", "tier_A", "tier_B"]], on=["source", "model"], how="left")
    priced = outcomes.dropna(subset=["blended_per_m"])
    tasks = tasks[tasks.uid.isin(set(priced.uid))].reset_index(drop=True)
    return dict(tasks=tasks, outcomes=priced.reset_index(drop=True), prices=prices, tokens=tokens)


def labels(b: dict, scheme: str = "A", models: dict | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(S, K): soft label and cost per task x tier, rows in b['tasks'] order. `models` optionally restricts the
    models per source (for split-half reliability)."""
    o = b["outcomes"]
    if models is not None:
        o = o[[m in models.get(s, ()) for s, m in zip(o.source, o.model)]]
    col = f"tier_{scheme}"
    S = o.pivot_table(index="uid", columns=col, values="score", aggfunc="mean").reindex(index=b["tasks"].uid, columns=list(TIERS))
    pr = b["prices"].dropna(subset=["blended_per_m"])
    tp = pr.groupby(["source", col]).blended_per_m.mean().unstack().reindex(columns=list(TIERS))
    K = np.array([tp.loc[s].to_numpy() * b["tokens"][s] / 1e6 for s in b["tasks"].source])
    return S.to_numpy(float), K


def cheapest_sufficient(S: np.ndarray, thr: float = 0.5) -> np.ndarray:
    """0/1/2 = cheapest tier with soft label >= thr; 3 = none."""
    ok = S >= thr
    return np.where(ok.any(1), ok.argmax(1), 3)
