"""Stage 4 shared pieces: the model-level arm table and stream orders.

Arms (rule declared before any policy was run): one arm per canonical model of the core slice (stage 1), the NEWEST
submission of that model (the run a router would deploy today; ties never occur); models without a per-instance cost
are dropped (gemini-3.5-flash: n_instance_cost = 0), leaving 33 arms. Per arm: per-task resolved (0/1, single run) and
per-task cost in $ (mini-SWE-agent's own `cost`), its list price (blended 3:1 $/M, stage 1's models.csv), its scheme-A
price band (low < 0.80 <= mid < 3.44 <= high, $/M) and its public headline solve rate (`meta_resolved_pct`, the
leaderboard number). NOTE: the headline is the mean of the very same 500 per-task outcomes, so any rule that reads it
uses an aggregate of the evaluation data (it is an in-sample statistic here; in production a leaderboard is measured
on a public benchmark, not on the router's own traffic).

Stream orders (200 streams each): "random" (a fresh permutation per stream), "by_repo" (repositories in a random order
per stream, created_at inside a repository, stage 2's construction), "created_at" (one global order, identical in every
stream; streams then differ only in the policies' own randomness).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import config as C
from .stage2 import load_matrix

N_STREAMS = 200
BAND_NAMES = ("low", "mid", "high")
ORDERS = ("random", "by_repo", "created_at")


@dataclass
class Arms:
    names: list  # canonical model names
    subs: list  # submission ids
    band: np.ndarray  # (K,) 0/1/2
    price: np.ndarray  # (K,) blended $/M
    headline: np.ndarray  # (K,) public headline solve rate (fraction)
    R: np.ndarray  # (K, n_task) 0/1
    Kc: np.ndarray  # (K, n_task) $ per task
    tasks: pd.DataFrame


def load_arms() -> Arms:
    M = load_matrix()
    s = M.subs.copy()
    s["row"] = np.arange(len(s))
    s["has_cost"] = ~np.isnan(M.cost).all(1)
    s = s[s.has_cost].sort_values(["canon", "date", "submission"])
    s = s.groupby("canon", as_index=False).tail(1).sort_values("canon").reset_index(drop=True)
    rows = s.row.to_numpy()
    R = M.R[rows].astype(float)
    Kc = M.cost[rows].copy()
    for j in range(len(rows)):  # fill the rare missing cell with the model's median cost
        m = np.isnan(Kc[j])
        if m.any():
            Kc[j, m] = np.nanmedian(Kc[j])
    band = s.tier_A_model_terciles.map({b: i for i, b in enumerate(BAND_NAMES)}).to_numpy()
    return Arms(s.canon.tolist(), s.submission.tolist(), band, s.blended_per_m.to_numpy(float),
                s.meta_resolved_pct.to_numpy(float) / 100, R, Kc, M.tasks)


def make_orders(tasks: pd.DataFrame, kind: str, n_streams: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = len(tasks)
    created = pd.to_datetime(tasks["created_at"]).to_numpy()
    if kind == "random":
        return np.array([rng.permutation(n) for _ in range(n_streams)])
    if kind == "created_at":
        o = np.argsort(created, kind="stable")
        return np.tile(o, (n_streams, 1))
    if kind == "by_repo":
        repos = sorted(tasks["repo"].unique())
        rid = tasks["repo"].map({r: i for i, r in enumerate(repos)}).to_numpy()
        by = [np.where(rid == r)[0][np.argsort(created[rid == r], kind="stable")] for r in range(len(repos))]
        return np.array([np.concatenate([by[r] for r in rng.permutation(len(repos))]) for _ in range(n_streams)])
    raise ValueError(kind)


def boot_stat(x, f=np.mean, n=1000, seed=C.SEED):
    """Point and 95 % bootstrap interval of f over streams (axis 0)."""
    x = np.asarray(x)
    rng = np.random.default_rng(seed)
    vals = [f(x[rng.integers(0, len(x), len(x))]) for _ in range(n)]
    return {"point": float(f(x)), "lo": float(np.percentile(vals, 2.5)), "hi": float(np.percentile(vals, 97.5))}
