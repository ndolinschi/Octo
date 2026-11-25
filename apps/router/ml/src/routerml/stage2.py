"""Stage 2 shared loaders: the core outcome matrix (submission x task) with its tier assignment.

Everything here reads stage 1's derived tables (results/outcomes_core.csv.gz, results/submissions.csv) and the
pinned task file; nothing from stage 1 is changed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import config as C
from .build import load_tasks

SCHEMES = ("A_model_terciles", "B_fixed_1_5", "C_submission_terciles")


@dataclass
class Matrix:
    tasks: pd.DataFrame  # sorted by instance_id
    subs: pd.DataFrame  # core submissions, row order = R's rows
    R: np.ndarray  # (n_sub, n_task) 0/1 resolved
    cost: np.ndarray  # (n_sub, n_task) $ per instance, nan where missing
    calls: np.ndarray  # (n_sub, n_task) api_calls, nan where missing

    def tier_idx(self, scheme: str) -> np.ndarray:
        return self.subs[f"tier_{scheme}"].map({t: i for i, t in enumerate(C.TIERS)}).to_numpy()


def load_matrix() -> Matrix:
    tasks = load_tasks().sort_values("instance_id").reset_index(drop=True)
    subs = pd.read_csv(C.RESULTS / "submissions.csv")
    subs = subs[subs.in_core].sort_values("submission").reset_index(drop=True)
    out = pd.read_csv(C.RESULTS / "outcomes_core.csv.gz")
    ids = tasks["instance_id"].tolist()
    piv = {c: out.pivot(index="submission", columns="instance_id", values=c).loc[subs.submission, ids].to_numpy(float)
           for c in ("resolved", "cost_usd", "api_calls")}
    return Matrix(tasks, subs, piv["resolved"], piv["cost_usd"], piv["api_calls"])


def cell_means(M: np.ndarray, rows: np.ndarray, tier: np.ndarray, fill_tier_median: bool = True) -> np.ndarray:
    """(n_task, 3): mean over the given submission rows of each tier; nan cells filled with that tier's median."""
    out = np.full((M.shape[1], 3), np.nan)
    for t in range(3):
        r = rows[tier[rows] == t]
        if len(r):
            with np.errstate(all="ignore"):
                v = np.nanmean(M[r], axis=0) if np.isnan(M[r]).any() else M[r].mean(0)
            out[:, t] = v
        if fill_tier_median and np.isnan(out[:, t]).any():
            med = np.nanmedian(M[r]) if len(r) and not np.isnan(M[r]).all() else np.nanmedian(M[tier == t])
            out[np.isnan(out[:, t]), t] = med
    return out


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if np.isnan(o) else round(float(o), 5)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def save(name: str, obj) -> None:
    (C.RESULTS / name).write_text(json.dumps(clean(obj), indent=1))


def ci(x, lo=2.5, hi=97.5) -> dict:
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    return {"mean": float(x.mean()), "lo": float(np.percentile(x, lo)), "hi": float(np.percentile(x, hi))}
