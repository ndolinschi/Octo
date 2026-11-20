"""Stage 6, part 1: the label table and how reliable it is, per source (results/stage6_labels.json).

Split-half over models: each tier's models in a source are split at random into two halves, a soft label is built from
each half, and the two are correlated across tasks (Spearman-Brown corrected to full length). Done for the per-tier
soft label, for the advantage of one tier over another (what routing needs), and for the cheapest sufficient tier
(Cohen's kappa between halves). 200 random splits; the mean and the 2.5 / 97.5 percentiles are reported. A tier with a
single model in a source cannot be split (reported as null).

Also: how much of each tier's label variance lies between sources (eta squared) - the share a source-id lookup could
explain - and the price ranking of tiers against their solve rate (a tier above can solve less).
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config as C
from . import stage6_data as D

N_SPLITS = 200


def _sb(r: float) -> float:
    return 2 * r / (1 + r) if np.isfinite(r) and r > -1 else np.nan


def _corr(a: np.ndarray, b: np.ndarray) -> float:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3 or a[ok].std() == 0 or b[ok].std() == 0:
        return np.nan
    return float(np.corrcoef(a[ok], b[ok])[0, 1])


def _kappa(x: np.ndarray, y: np.ndarray, k: int = 4) -> float:
    m = np.zeros((k, k))
    for a, b in zip(x, y):
        m[a, b] += 1
    n = m.sum()
    po = np.trace(m) / n
    pe = (m.sum(0) * m.sum(1)).sum() / n**2
    return float((po - pe) / (1 - pe)) if pe < 1 else np.nan


def split_half(b: dict, scheme: str = "A", n: int = N_SPLITS, seed: int = C.SEED) -> dict:
    rng = np.random.default_rng(seed)
    pr = b["prices"].dropna(subset=["blended_per_m"])
    col = f"tier_{scheme}"
    tiers = {(s, t): sorted(g.model) for (s, t), g in pr.groupby(["source", col])}
    src = b["tasks"].source.to_numpy()
    names = ["low", "mid", "high", "high-low", "mid-low", "high-mid", "cheapest_sufficient_kappa"]
    acc = {s: {k: [] for k in names} for s in (*D.SOURCES, "pooled")}
    for _ in range(n):
        h1, h2 = {}, {}
        for (s, t), ms in tiers.items():
            if len(ms) < 2:
                h1.setdefault(s, set()).update(ms)  # unsplittable tier: both halves share it (excluded below)
                h2.setdefault(s, set()).update(ms)
                continue
            p = rng.permutation(ms)
            h1.setdefault(s, set()).update(p[: len(p) // 2])
            h2.setdefault(s, set()).update(p[len(p) // 2 :])
        S1, _ = D.labels(b, scheme, h1)
        S2, _ = D.labels(b, scheme, h2)
        for s in (*D.SOURCES, "pooled"):
            m = np.ones(len(src), bool) if s == "pooled" else src == s
            single = {t for t in D.TIERS if s != "pooled" and len(tiers.get((s, t), [])) < 2}
            for j, t in enumerate(D.TIERS):
                acc[s][t].append(np.nan if t in single else _sb(_corr(S1[m, j], S2[m, j])))
            for name, (hi, lo) in (("high-low", (2, 0)), ("mid-low", (1, 0)), ("high-mid", (2, 1))):
                bad = {D.TIERS[hi], D.TIERS[lo]} & single
                acc[s][name].append(np.nan if bad else _sb(_corr(S1[m, hi] - S1[m, lo], S2[m, hi] - S2[m, lo])))
            acc[s]["cheapest_sufficient_kappa"].append(
                np.nan if single else _kappa(D.cheapest_sufficient(S1[m]), D.cheapest_sufficient(S2[m]))
            )
    out = {}
    for s, d in acc.items():
        out[s] = {}
        for k, v in d.items():
            v = np.array(v, float)
            out[s][k] = None if np.isnan(v).all() else [round(float(np.nanmean(v)), 3), round(float(np.nanpercentile(v, 2.5)), 3), round(float(np.nanpercentile(v, 97.5)), 3)]
    return out


def eta_squared(S: np.ndarray, src: np.ndarray) -> list[float]:
    out = []
    for j in range(S.shape[1]):
        y = S[:, j]
        tot = ((y - y.mean()) ** 2).sum()
        btw = sum(((src == s).sum() * (y[src == s].mean() - y.mean()) ** 2) for s in np.unique(src))
        out.append(round(float(btw / tot), 3))
    return out


def summary(b: dict, scheme: str) -> dict:
    t = b["tasks"]
    S, K = D.labels(b, scheme)
    src = t.source.to_numpy()
    pr = b["prices"].dropna(subset=["blended_per_m"])
    res = {}
    for s in D.SOURCES:
        m = src == s
        cst = D.cheapest_sufficient(S[m])
        res[s] = {
            "tasks": int(m.sum()),
            "models_per_tier": pr[pr.source == s].groupby(f"tier_{scheme}").model.count().reindex(list(D.TIERS)).fillna(0).astype(int).to_dict(),
            "mean_soft_label": dict(zip(D.TIERS, np.round(S[m].mean(0), 3).tolist())),
            "cost_per_task_usd": dict(zip(D.TIERS, np.round(K[m].mean(0), 5).tolist())),
            "tokens_per_task_assumed": round(b["tokens"][s]),
            "cheapest_sufficient_share": dict(zip(["low", "mid", "high", "none"], np.round(np.bincount(cst, minlength=4) / m.sum(), 3).tolist())),
            "share_soft_label_between_0.2_and_0.8": dict(zip(D.TIERS, np.round(((S[m] > 0.2) & (S[m] < 0.8)).mean(0), 3).tolist())),
            "tier_monotone_in_solve_rate": bool(np.all(np.diff(S[m].mean(0)) >= 0)),
        }
    cst = D.cheapest_sufficient(S)
    res["pooled"] = {
        "tasks": len(t),
        "cheapest_sufficient_share": dict(zip(["low", "mid", "high", "none"], np.round(np.bincount(cst, minlength=4) / len(t), 3).tolist())),
        "eta_squared_of_source_per_tier": dict(zip(D.TIERS, eta_squared(S, src))),
    }
    # Is the range wide? spread of the mean soft label across tasks, per source
    res["spread_of_task_mean_label"] = {
        s: [round(float(np.percentile(S[src == s].mean(1), q)), 3) for q in (10, 50, 90)] for s in D.SOURCES
    }
    return res


def main() -> None:
    b = D.build()
    out = {"schemes": {}, "prices": b["prices"].assign(blended_per_m=b["prices"].blended_per_m.round(4)).to_dict("records")}
    for scheme in ("A", "B"):
        out["schemes"][scheme] = {"summary": summary(b, scheme), "split_half": split_half(b, scheme)}
    out["tokens_per_task"] = {k: round(v) for k, v in b["tokens"].items()}
    out["excluded_unpriced_models"] = b["prices"][b["prices"].blended_per_m.isna()][["source", "model"]].to_dict("records")
    C.RESULTS.mkdir(exist_ok=True)
    (C.RESULTS / "stage6_labels.json").write_text(json.dumps(out, indent=1, default=lambda o: None if isinstance(o, float) and np.isnan(o) else str(o)))
    pd.set_option("display.width", 200)
    print(json.dumps({k: v["split_half"] for k, v in out["schemes"].items()}, indent=1))
    print(json.dumps(out["schemes"]["A"]["summary"], indent=1))


if __name__ == "__main__":
    main()
