"""Stage 1: outcomes long table, models/prices, tiers under three cut schemes, label table, cost table.

Outputs (results/): submissions.csv, models.csv, excluded_submissions.csv, tier_counts.json,
labels_<scheme>_<slice>.csv, cost_<scheme>_<slice>.csv, label_stats.json, outcomes_core.csv.gz.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from . import config as C

# --- model identity -------------------------------------------------------------------------
# Raw `tags.model` strings (lower-cased) -> canonical model name.
ALIASES = {
    "llama-4-maverick-instruct": "llama-4-maverick",
    "claude-3-7-sonnet-20250219": "claude-3.7-sonnet",
    "claude-4-sonnet-20250514": "claude-sonnet-4",
    "claude-sonnet-4-20250514": "claude-sonnet-4",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "o3-20250416": "o3",
    "o3": "o3",
    "o4-mini-20250416": "o4-mini",
    "o4-mini": "o4-mini",
    "claude-4-opus-20250514": "claude-opus-4",
    "qwen3-coder-480b-a35b-instruct": "qwen3-coder-480b",
    "qwen2.5-coder-32b-instruct": "qwen2.5-coder-32b",
    "gpt-5-mini-2025-08-07": "gpt-5-mini",
    "gpt-5-nano-2025-08-07": "gpt-5-nano",
    "gpt-5-2025-08-07": "gpt-5",
    "gpt-oss-120b": "gpt-oss-120b",
    "kimi-k2-instruct": "kimi-k2",
    "moonshot/kimi-k2-0711-preview": "kimi-k2",
    "glm-4.5": "glm-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
    "gemini-3-pro-preview": "gemini-3-pro",
    "gpt-5.1-2025-11-13": "gpt-5.1",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
    "claude-4-5-opus": "claude-opus-4.5",
    "gpt-5.1-codex": "gpt-5.1-codex",
    "minimax-m2": "minimax-m2",
    "deepseek-v3.2-reasoner": "deepseek-v3.2-reasoner",
    "glm-4.6": "glm-4.6",
    "devstral-2512": "devstral-2512",
    "devstral-small-2512": "devstral-small-2512",
    "kimi-k2-thinking": "kimi-k2-thinking",
    "gpt-5.2-2025-12-11": "gpt-5.2",
    "gpt-5-2": "gpt-5.2",
    "claude-haiku-4-5-20251001": "claude-haiku-4.5",
    "claude-opus-4-6": "claude-opus-4.6",
    "deepseek-v3.2": "deepseek-v3.2",
    "gemini-3-flash-preview": "gemini-3-flash",
    "glm-5": "glm-5",
    "kimi-k2.5": "kimi-k2.5",
    "minimax-m2.5": "minimax-m2.5",
    "gpt-5-2-codex": "gpt-5.2-codex",
    "gemini-3-5-flash": "gemini-3.5-flash",
    # full-matrix extras (single-model submissions of other scaffolds)
    "claude-3-5-sonnet-20241022": "claude-3.5-sonnet",
    "gpt-4o-2024-05-13": "gpt-4o-2024-05-13",
    "gpt-4o-2024-08-06": "gpt-4o-2024-08-06",
    "gpt-4-1106-preview": "gpt-4-turbo-1106",
    "o3-mini": "o3-mini",
    "claude-3-5-haiku": "claude-3.5-haiku",
}

# canonical -> (provider, [(source, key), ...]); first hit wins. "litellm" = LiteLLM price table at
# config.LITELLM_COMMIT; "openrouter" = the OpenRouter catalogue snapshot of config.PRICES_FETCHED.
SOURCES: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "llama-4-maverick": ("Meta", [("openrouter", "meta-llama/llama-4-maverick")]),
    "claude-3.7-sonnet": ("Anthropic", [("litellm", "anthropic.claude-3-7-sonnet-20250219-v1:0")]),
    "claude-sonnet-4": ("Anthropic", [("litellm", "anthropic.claude-sonnet-4-20250514-v1:0")]),
    "gemini-2.5-pro": ("Google", [("litellm", "gemini/gemini-2.5-pro")]),
    "o3": ("OpenAI", [("litellm", "o3-2025-04-16")]),
    "o4-mini": ("OpenAI", [("litellm", "o4-mini-2025-04-16")]),
    "claude-opus-4": ("Anthropic", [("litellm", "anthropic.claude-opus-4-20250514-v1:0")]),
    "qwen3-coder-480b": ("Qwen", [("openrouter", "qwen/qwen3-coder")]),
    "qwen2.5-coder-32b": ("Qwen", [("openrouter", "qwen/qwen-2.5-coder-32b-instruct")]),
    "gpt-5-mini": ("OpenAI", [("litellm", "gpt-5-mini-2025-08-07")]),
    "gpt-5-nano": ("OpenAI", [("litellm", "gpt-5-nano-2025-08-07")]),
    "gpt-5": ("OpenAI", [("litellm", "gpt-5-2025-08-07")]),
    "gpt-oss-120b": ("OpenAI", [("openrouter", "openai/gpt-oss-120b")]),
    "kimi-k2": ("Moonshot AI", [("openrouter", "moonshotai/kimi-k2")]),
    "glm-4.5": ("Z.ai", [("litellm", "zai/glm-4.5")]),
    "claude-sonnet-4.5": ("Anthropic", [("litellm", "claude-sonnet-4-5-20250929")]),
    "gemini-3-pro": ("Google", [("litellm", "vertex_ai/gemini-3-pro-preview")]),
    "gpt-5.1": ("OpenAI", [("litellm", "gpt-5.1-2025-11-13")]),
    "claude-opus-4.5": ("Anthropic", [("litellm", "claude-opus-4-5-20251101")]),
    "gpt-5.1-codex": ("OpenAI", [("litellm", "gpt-5.1-codex")]),
    "minimax-m2": ("MiniMax", [("litellm", "minimax/MiniMax-M2")]),
    "deepseek-v3.2-reasoner": ("DeepSeek", [("litellm", "deepseek/deepseek-reasoner")]),
    "glm-4.6": ("Z.ai", [("litellm", "zai/glm-4.6")]),
    "devstral-2512": ("Mistral", [("openrouter", "mistralai/devstral-2512")]),
    "devstral-small-2512": ("Mistral", [("litellm", "mistral/devstral-small-latest")]),
    "kimi-k2-thinking": ("Moonshot AI", [("openrouter", "moonshotai/kimi-k2-thinking")]),
    "gpt-5.2": ("OpenAI", [("litellm", "gpt-5.2-2025-12-11")]),
    "claude-haiku-4.5": ("Anthropic", [("litellm", "claude-haiku-4-5-20251001")]),
    "claude-opus-4.6": ("Anthropic", [("litellm", "claude-opus-4-6")]),
    "deepseek-v3.2": ("DeepSeek", [("litellm", "deepseek/deepseek-v3.2")]),
    "gemini-3-flash": ("Google", [("litellm", "gemini/gemini-3-flash-preview")]),
    "glm-5": ("Z.ai", [("openrouter", "z-ai/glm-5")]),
    "kimi-k2.5": ("Moonshot AI", [("litellm", "moonshot/kimi-k2.5")]),
    "minimax-m2.5": ("MiniMax", [("litellm", "minimax/MiniMax-M2.5")]),
    "gpt-5.2-codex": ("OpenAI", [("litellm", "gpt-5.2-codex")]),
    "gemini-3.5-flash": ("Google", [("litellm", "gemini/gemini-3.5-flash")]),
    "claude-3.5-sonnet": ("Anthropic", [("litellm", "vercel_ai_gateway/anthropic/claude-3-5-sonnet-20241022")]),
    "gpt-4o-2024-05-13": ("OpenAI", [("litellm", "gpt-4o-2024-05-13")]),
    "gpt-4o-2024-08-06": ("OpenAI", [("litellm", "azure/global/gpt-4o-2024-08-06"), ("openrouter", "openai/gpt-4o-2024-08-06")]),
    "gpt-4-turbo-1106": ("OpenAI", [("litellm", "gpt-4-1106-preview")]),
    "o3-mini": ("OpenAI", [("litellm", "azure/o3-mini")]),
    "claude-3.5-haiku": ("Anthropic", [("litellm", "vertex_ai/claude-3-5-haiku")]),
}
# Known caveats of "price now" vs "price at the time of the run".
PRICE_NOTES = {
    "devstral-2512": "free on the Mistral API at release (Dec 2025); the run's own cost is null in metadata; list price used",
    "devstral-small-2512": "LiteLLM key is the 'latest' alias, not the dated model; free at release; list price used",
    "o3": "OpenAI cut o3 from 10/40 to 2/8 in June 2025; the run (2025-07-26) is after the cut",
    "qwen3-coder-480b": "open-weights model; price is one provider's (OpenRouter list), many hosts exist",
    "qwen2.5-coder-32b": "open-weights model; OpenRouter list price",
    "llama-4-maverick": "open-weights model; OpenRouter list price",
    "gpt-oss-120b": "open-weights model; OpenRouter list price",
    "kimi-k2": "OpenRouter list price of moonshotai/kimi-k2 (0711)",
    "gemini-3-pro": "Vertex list price (<=200k context tier) of the preview model",
    "claude-3.7-sonnet": "Bedrock key; same list price as the Anthropic API (3/15)",
    "claude-sonnet-4": "Bedrock key; same list price as the Anthropic API (3/15)",
    "claude-opus-4": "Bedrock key; same list price as the Anthropic API (15/75)",
}
BLEND_IN, BLEND_OUT = 3, 1  # blended $/M = (3*input + 1*output)/4

# The router's ladder (config/autoroute.toml + config/prices.toml, read 2026-11-13).
ROUTER_LADDER = {
    "low": ("deepseek/deepseek-v4.1-flash", 0.051, 0.567),
    "mid": ("minimax/minimax-m3.1-flash", 0.15, 0.60),
    "high": ("deepseek/deepseek-v4.1-flash-1017", 0.006, 0.50),
}

CORE_AGENT = "mini-SWE-agent"
RESOLVED_TOL_PP = 1.5  # per-instance resolved count must match metadata `resolved` % within this


def blended(inp: float, out: float) -> float:
    return (BLEND_IN * inp + BLEND_OUT * out) / (BLEND_IN + BLEND_OUT)


def load_tasks() -> pd.DataFrame:
    df = pd.read_parquet(C.DATA / "swebench_verified.parquet")
    df["created_at"] = pd.to_datetime(df["created_at"], utc=True)
    return df


def _norm_models(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = [raw]
    return [str(x) for x in raw]


def read_submissions(universe: list[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (submission metadata, long outcomes over all usable submissions)."""
    rows, outs = [], []
    uni = set(universe)
    for d in sorted((C.DATA / "submissions").iterdir()):
        meta_p = d / "metadata.yaml"
        meta = yaml.safe_load(meta_p.read_text()) if meta_p.exists() else {}
        info, tags = meta.get("info", {}) or {}, meta.get("tags", {}) or {}
        models = _norm_models(tags.get("model"))
        pid = d / "per_instance_details.json"
        res = d / "results.json"
        resolved: dict[str, int] | None = None
        cost: dict[str, float] = {}
        calls: dict[str, float] = {}
        source = None
        if pid.exists():
            det = json.loads(pid.read_text())
            resolved = {k: int(bool(v.get("resolved"))) for k, v in det.items()}
            cost = {k: v["cost"] for k, v in det.items() if v.get("cost") is not None}
            calls = {k: v["api_calls"] for k, v in det.items() if v.get("api_calls") is not None}
            source = "per_instance_details"
        if res.exists():
            r = json.loads(res.read_text())
            if "resolved" in r:
                ids = set(r["resolved"])
                if resolved is None or source == "per_instance_details" and len(resolved) < len(uni):
                    # results.json is the authoritative full list when per-instance details are partial
                    resolved = {i: int(i in ids) for i in uni}
                    source = "results.json"
        attempts = str((tags.get("system") or {}).get("attempts"))
        n_res = sum(resolved.values()) if resolved else None
        meta_pct = info.get("resolved")
        rows.append(
            dict(
                submission=d.name,
                name=info.get("name"),
                agent=tags.get("agent"),
                models_raw="|".join(models),
                n_models=len(models),
                date=d.name[:8],
                attempts=attempts,
                has_metadata=meta_p.exists(),
                has_results_json=res.exists(),
                has_per_instance_details=pid.exists(),
                n_instance_cost=len(cost),
                meta_instance_cost=info.get("instance_cost"),
                meta_resolved_pct=meta_pct,
                outcome_source=source,
                n_outcomes=len(resolved) if resolved else 0,
                n_resolved=n_res,
                reasoning_effort=tags.get("reasoning_effort"),
            )
        )
        if resolved:
            for iid in universe:
                outs.append(
                    (d.name, iid, resolved.get(iid, 0), cost.get(iid, np.nan), calls.get(iid, np.nan))
                )
    sub = pd.DataFrame(rows)
    out = pd.DataFrame(outs, columns=["submission", "instance_id", "resolved", "cost_usd", "api_calls"])
    return sub, out


def price_table(canon: list[str]) -> tuple[pd.DataFrame, list[str]]:
    lit = json.loads((C.DATA / "litellm_prices.json").read_text())
    orr = {m["id"]: m for m in json.loads((C.DATA / "openrouter_models.json").read_text())["data"]}
    rows, missing = [], []
    for m in canon:
        if m not in SOURCES:
            missing.append(m)
            continue
        provider, srcs = SOURCES[m]
        hit = None
        for src, key in srcs:
            if src == "litellm" and key in lit and lit[key].get("input_cost_per_token") is not None:
                e = lit[key]
                hit = (src, key, e["input_cost_per_token"] * 1e6, e["output_cost_per_token"] * 1e6,
                       f"{C.LITELLM_URL}#{key}")
                break
            if src == "openrouter" and key in orr:
                p = orr[key]["pricing"]
                hit = (src, key, float(p["prompt"]) * 1e6, float(p["completion"]) * 1e6,
                       f"{C.OPENROUTER_URL} (snapshot {C.PRICES_FETCHED})#{key}")
                break
        if hit is None:
            missing.append(m)
            continue
        src, key, pin, pout, url = hit
        rows.append(dict(model=m, provider=provider, input_per_m=round(pin, 4), output_per_m=round(pout, 4),
                         blended_per_m=round(blended(pin, pout), 4), blend="3:1 input:output",
                         source=src, source_key=key, source_url=url, price_verified=True,
                         price_date=C.PRICES_FETCHED, note=PRICE_NOTES.get(m, "")))
    return pd.DataFrame(rows), missing


def cut_points(models: pd.DataFrame, subs: pd.DataFrame) -> dict[str, tuple[float, float]]:
    """Three pre-declared schemes (declared before any model was trained)."""
    lp = np.log(models["blended_per_m"].to_numpy())
    a = tuple(float(np.exp(q)) for q in np.quantile(lp, [1 / 3, 2 / 3]))
    ls = np.log(subs["blended_per_m"].to_numpy())
    c = tuple(float(np.exp(q)) for q in np.quantile(ls, [1 / 3, 2 / 3]))
    return {
        "A_model_terciles": a,  # headline: log-price terciles over distinct core models
        "B_fixed_1_5": (1.0, 5.0),  # round cut points: < $1/M, $1-5/M, >= $5/M blended
        "C_submission_terciles": c,  # terciles over core submissions (equal-size tiers)
    }


def assign(price: float, cuts: tuple[float, float]) -> str:
    return "low" if price < cuts[0] else ("mid" if price < cuts[1] else "high")


def labels_for(out: pd.DataFrame, subs: pd.DataFrame, tier_col: str, universe: list[str]) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    o = out.merge(subs[["submission", tier_col]], on="submission")
    g = o.groupby(["instance_id", tier_col])
    lab = g["resolved"].agg(share="mean", count="size", n_resolved="sum").reset_index().rename(columns={tier_col: "tier"})
    lab["hard"] = (lab["share"] > 0.5).astype(int)  # majority; a tie (share == 0.5) counts as not solved
    # cost: measured per-instance cost where present, else that tier's median of measured costs
    cst = g["cost_usd"].agg(cost_mean="mean", n_cost="count").reset_index().rename(columns={tier_col: "tier"})
    tier_median = o.groupby(tier_col)["cost_usd"].median()
    lab = lab.merge(cst, on=["instance_id", "tier"])
    lab["cost_measured_cells"] = lab["n_cost"]
    lab["cost"] = lab["cost_mean"].fillna(lab["tier"].map(tier_median))
    lab["cost_imputed"] = lab["cost_mean"].isna()
    # oracle tier
    wide = lab.pivot(index="instance_id", columns="tier", values="share").reindex(universe)
    orc = []
    for iid, r in wide.iterrows():
        t = next((t for t in C.TIERS if t in r and r[t] >= 0.5), "none")
        orc.append((iid, t))
    oracle = pd.DataFrame(orc, columns=["instance_id", "oracle_tier"])
    # noise: within-tier disagreement on a task
    def _dis(s):
        p = s.mean()
        return 2 * p * (1 - p)  # prob. two random runs of the tier disagree (with replacement)
    dis = o.groupby(["instance_id", tier_col])["resolved"].apply(_dis)
    unanimous = o.groupby(["instance_id", tier_col])["resolved"].agg(lambda s: s.min() == s.max())
    stats = {
        "rows": int(len(lab)),
        "tasks": int(lab["instance_id"].nunique()),
        "tasks_missing_a_tier": sorted(set(universe) - set(wide.dropna().index)),
        "mean_pairwise_disagreement_by_tier": {t: float(dis.xs(t, level=1).mean()) for t in C.TIERS},
        "share_tasks_unanimous_by_tier": {t: float(unanimous.xs(t, level=1).mean()) for t in C.TIERS},
        "share_soft_label_in_(0.2,0.8)_by_tier": {
            t: float(((lab[lab.tier == t].share > 0.2) & (lab[lab.tier == t].share < 0.8)).mean()) for t in C.TIERS
        },
        "mean_share_by_tier": {t: float(lab[lab.tier == t].share.mean()) for t in C.TIERS},
        "oracle_tier_counts": oracle["oracle_tier"].value_counts().to_dict(),
        "tier_cost_median_usd": {t: float(tier_median[t]) for t in C.TIERS},
        "mean_task_cost_by_tier_usd": {t: float(lab[lab.tier == t].cost.mean()) for t in C.TIERS},
        "cells_cost_measured": int((~lab["cost_imputed"]).sum()),
        "cells_cost_imputed": int(lab["cost_imputed"].sum()),
        "count_by_tier": {t: int(lab[lab.tier == t]["count"].iloc[0]) for t in C.TIERS},
    }
    return lab, oracle, stats


def main() -> None:
    C.RESULTS.mkdir(exist_ok=True)
    tasks = load_tasks()
    universe = sorted(tasks["instance_id"])
    subs, out = read_submissions(universe)
    subs["canon"] = subs["models_raw"].map(lambda s: ALIASES.get(s.lower()) if s and "|" not in s else None)

    # core = mini-SWE-agent (tags.agent) entries with per-instance outcomes that pass the sanity check
    core_mask = subs["agent"].eq(CORE_AGENT)
    reasons = {}
    for i, r in subs.iterrows():
        why = None
        if r.n_outcomes == 0:
            why = "no per-instance outcomes in the repo (only metadata)"
        elif r.meta_resolved_pct is not None and abs(100 * r.n_resolved / len(universe) - float(r.meta_resolved_pct)) > RESOLVED_TOL_PP:
            why = f"per-instance resolved {r.n_resolved}/500 disagrees with metadata {r.meta_resolved_pct}%"
        elif r.n_models != 1:
            why = f"{r.n_models} models listed ({r.models_raw or 'none'})"
        elif pd.isna(r.canon):
            why = f"model '{r.models_raw}' not mapped to a priced model"
        elif r.attempts not in ("1", "None"):
            why = f"attempts={r.attempts} (not pass@1)"
        reasons[r.submission] = why
    subs["exclusion_reason"] = subs["submission"].map(reasons)

    models, missing = price_table(sorted(set(subs.loc[subs.exclusion_reason.isna(), "canon"])))
    priced = set(models["model"])
    subs.loc[subs.exclusion_reason.isna() & ~subs.canon.isin(priced), "exclusion_reason"] = "model price not sourced"
    subs = subs.merge(models[["model", "blended_per_m"]], left_on="canon", right_on="model", how="left").drop(columns="model")
    subs["in_core"] = core_mask & subs.exclusion_reason.isna()
    subs["in_full"] = subs.exclusion_reason.isna()

    core_models = models[models.model.isin(subs.loc[subs.in_core, "canon"])]
    cuts = cut_points(core_models, subs[subs.in_core])
    for s, cp in cuts.items():
        subs[f"tier_{s}"] = [assign(p, cp) if not math.isnan(p) else None for p in subs["blended_per_m"]]
    for s, cp in cuts.items():
        models[f"tier_{s}"] = [assign(p, cp) for p in models["blended_per_m"]]
    models["in_core"] = models["model"].isin(core_models["model"])

    # router ladder check
    ladder = {t: blended(i, o) for t, (_, i, o) in ROUTER_LADDER.items()}
    ladder_monotone = ladder["low"] < ladder["mid"] < ladder["high"]
    n_within = int((core_models["blended_per_m"] <= max(ladder.values())).sum())

    subs.to_csv(C.RESULTS / "submissions.csv", index=False)
    subs[subs.exclusion_reason.notna()][["submission", "agent", "models_raw", "exclusion_reason"]].to_csv(
        C.RESULTS / "excluded_submissions.csv", index=False)
    models.to_csv(C.RESULTS / "models.csv", index=False)

    tier_counts = {}
    label_stats = {}
    for sl in ("core", "full"):
        s_sl = subs[subs[f"in_{sl}"]]
        o_sl = out[out.submission.isin(s_sl.submission)]
        if sl == "core":
            o_sl.to_csv(C.RESULTS / "outcomes_core.csv.gz", index=False)
        for s in cuts:
            col = f"tier_{s}"
            tier_counts[f"{s}/{sl}"] = {
                t: {"submissions": int((s_sl[col] == t).sum()), "models": int(s_sl.loc[s_sl[col] == t, "canon"].nunique())}
                for t in C.TIERS
            }
            lab, oracle, st = labels_for(o_sl, s_sl, col, universe)
            lab = lab.merge(oracle, on="instance_id")
            lab.to_csv(C.RESULTS / f"labels_{s}_{sl}.csv", index=False)
            label_stats[f"{s}/{sl}"] = st

    meta = {
        "sources": {
            "swebench_verified": {"dataset": C.HF_DATASET, "revision": C.HF_REVISION, "tasks": len(universe)},
            "swebench_experiments": {"url": C.EXPERIMENTS_URL, "commit": C.EXPERIMENTS_COMMIT},
            "litellm_prices": {"url": C.LITELLM_URL, "commit": C.LITELLM_COMMIT},
            "openrouter_catalogue": {"url": C.OPENROUTER_URL, "snapshot": C.PRICES_FETCHED},
        },
        "submissions_verified_total": int(len(subs)),
        "submissions_with_outcomes": int((subs.n_outcomes > 0).sum()),
        "mini_swe_agent_entries": int(core_mask.sum()),
        "core_submissions": int(subs.in_core.sum()),
        "full_submissions": int(subs.in_full.sum()),
        "core_models": int(core_models.shape[0]),
        "models_priced": int(len(models)),
        "models_price_verified": int(models.price_verified.sum()),
        "models_unpriced_excluded": missing,
        "outcome_rows_core": int(out.submission.isin(subs.loc[subs.in_core, "submission"]).sum()),
        "outcome_rows_full": int(out.submission.isin(subs.loc[subs.in_full, "submission"]).sum()),
        "cut_points_usd_per_m_blended": {k: [round(x, 4) for x in v] for k, v in cuts.items()},
        "router_ladder_blended_usd_per_m": {t: round(v, 4) for t, v in ladder.items()},
        "router_ladder_monotone_in_price": ladder_monotone,
        "core_models_priced_at_or_below_router_ladder_max": n_within,
        "tier_counts": tier_counts,
        "label_stats": label_stats,
        "core_submissions_with_measured_instance_cost": int((subs.in_core & (subs.n_instance_cost > 0)).sum()),
    }
    (C.RESULTS / "build.json").write_text(json.dumps(meta, indent=1, default=str))
    print(json.dumps({k: v for k, v in meta.items() if k not in ("label_stats",)}, indent=1, default=str))
    for k, v in label_stats.items():
        print(k, {kk: vv for kk, vv in v.items() if kk != "tasks_missing_a_tier"}, "missing:", len(v["tasks_missing_a_tier"]))


if __name__ == "__main__":
    main()
