"""Stage 5 data: target matrices ("the router's own traffic") and the model matching to the Verified core (stage 4 arms).

TERMINAL-BENCH 2 (config.TB2_REVISION). A system = one leaderboard folder <Agent>__<Model>. Trials are read from the
job summaries (<job>/result.json: stats.evals.*.reward_stats.reward = {reward value: [trial names]},
exception_stats = {exception type: [trial names]}). Rules (declared before reading any outcome):
  * only jobs on Terminal-Bench 2.0 are kept (eval key ends with "terminal-bench", "terminal-bench-2",
    "terminal-bench-2.0" or "terminal-bench-terminal-bench-2"; "terminal-bench-2-1" and custom sets are dropped);
  * a trial WITH a reward keeps it (some AgentTimeoutError trials were verified and carry a reward);
  * a trial without a reward whose exception is AgentTimeoutError counts as 0 (the agent ran out of its time budget:
    a failure of the system, as the leaderboard counts it);
  * any other trial without a reward (RuntimeError from docker, API errors, verifier timeouts, setup timeouts) is an
    infrastructure failure and is DROPPED (not counted as 0). The leaderboard itself counts them as 0; the rule is
    chosen so that a model is not penalised for its submitter's infrastructure;
  * a job without a `stats` block is read from its per-trial result.json files only if those were fetched; else dropped.
  * reward is used as is (it is 0/1 on every kept trial; asserted).
  Cost per trial: agent_result.cost_usd of the per-trial result.json (fetched only for the systems of matched models).

MODEL MATCHING (deterministic; tests/test_stage5.py checks the list). norm_model(raw):
  lower-case; drop a provider prefix up to the last "/"; drop "-preview", a trailing date (-YYYYMMDD or -YYYY-MM-DD)
  and "-highspeed"; "claude-<family>-<a>-<b>" and "claude-<a>.<b>-<family>" -> "claude-<family>-<a>.<b>";
  "gpt5.1" -> "gpt-5.1"; "minimax-2.5" -> "minimax-m2.5", "minimax-m2-7" -> "minimax-m2.7"; "glm-4-7" -> "glm-4.7"; then build.ALIASES if the string is an alias key; result compared with the
  33 canonical arm names exactly. The model of a TB2 system is its metadata.yaml models list when it has ONE entry
  (systems with several models are routers/ensembles and are excluded); the folder suffix after "__" is normalised
  the same way and a disagreement with metadata marks the system "conflict" (excluded).
  Multilingual: tags.model of metadata.yaml through the same norm_model (it applies build.ALIASES, stage 1's rule).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from . import config as C
from .build import ALIASES

TB2_SYS = C.DATA / "tb2" / "submissions" / "terminal-bench" / "2.0"
ML_DIR = C.DATA / "multilingual"
SCAFFOLD = "Terminus2"
# eval keys of Terminal-Bench 2.0 jobs (submitters name the dataset differently); 2.1 and custom sets are dropped
TB20_KEY = re.compile(r"__(terminal-bench/)?terminal-bench(-terminal-bench)?(-2|-2\.0)?$")  # the reference agent of the benchmark; the TB2 scaffold with the most single-model systems


def norm_model(raw: str) -> str:
    s = str(raw).strip().strip('"').lower()
    s = s.rsplit("/", 1)[-1]
    s = s.replace("_", "-")
    s = re.sub(r"-preview$", "", s)
    s = re.sub(r"-(20\d{6}|20\d{2}-\d{2}-\d{2})$", "", s)
    s = re.sub(r"-highspeed$", "", s)
    s = re.sub(r"-preview$", "", s)
    m = re.fullmatch(r"claude-(opus|sonnet|haiku)-(\d)[-.](\d)", s)
    if m:
        s = f"claude-{m[1]}-{m[2]}.{m[3]}"
    m = re.fullmatch(r"claude-(\d)[-.](\d)-(opus|sonnet|haiku)", s)
    if m:
        s = f"claude-{m[3]}-{m[1]}.{m[2]}"
    m = re.fullmatch(r"(opus|sonnet|haiku)-(\d)[-.](\d)", s)
    if m:
        s = f"claude-{m[1]}-{m[2]}.{m[3]}"
    s = re.sub(r"^gpt(\d)", r"gpt-\1", s)
    s = re.sub(r"^minimax-(\d)", r"minimax-m\1", s)
    s = re.sub(r"^minimax-m(\d)-(\d)$", r"minimax-m\1.\2", s)
    s = re.sub(r"^glm-(\d)-(\d)$", r"glm-\1.\2", s)
    return ALIASES.get(s, s)


# --------------------------------------------------------------------------------------------- Terminal-Bench 2
def tb2_systems() -> pd.DataFrame:
    rows = []
    for d in sorted(p for p in TB2_SYS.iterdir() if p.is_dir()):
        meta = yaml.safe_load((d / "metadata.yaml").read_text()) if (d / "metadata.yaml").exists() else {}
        models = [m.get("model_name") for m in (meta.get("models") or [])]
        agent, _, suffix = d.name.partition("__")
        if not suffix:  # folders named with one underscore
            agent, _, suffix = d.name.partition("_")
        from_meta = norm_model(models[0]) if len(models) == 1 else None
        from_name = norm_model(suffix)
        status = "multi-model" if len(models) != 1 else ("ok" if from_meta == from_name else "conflict")
        rows.append({"system": d.name, "agent": agent, "agent_display": meta.get("agent_display_name"),
                     "models_raw": "|".join(map(str, models)), "model": from_meta if status != "multi-model" else None,
                     "model_from_folder": from_name, "status": status})
    return pd.DataFrame(rows)


def tb2_trials() -> pd.DataFrame:
    """One row per kept trial: system, job, task, trial, reward, exception, cost (nan where absent)."""
    rows, dropped = [], []
    for d in sorted(p for p in TB2_SYS.iterdir() if p.is_dir()):
        for jr in sorted(d.glob("*/result.json")):
            js = json.loads(jr.read_text())
            if "stats" not in js:
                dropped.append((d.name, jr.parent.name, "no stats block"))
                continue
            for key, e in js["stats"]["evals"].items():
                if not TB20_KEY.search(key):
                    dropped.append((d.name, jr.parent.name, f"dataset {key.rsplit('__', 1)[-1]}"))
                    continue
                rew = {}
                for r, lst in ((e.get("reward_stats") or {}).get("reward") or {}).items():
                    for t in lst:
                        rew[t] = float(r)
                exc = {}
                for x, lst in (e.get("exception_stats") or {}).items():
                    for t in lst:
                        exc[t] = x
                for t in sorted(set(rew) | set(exc)):
                    if t in rew:
                        y = rew[t]
                    elif exc.get(t) == "AgentTimeoutError":
                        y = 0.0
                    else:
                        continue
                    cost, tin, tout = np.nan, np.nan, np.nan
                    tf = jr.parent / t / "result.json"
                    if tf.exists():
                        ar = json.loads(tf.read_text()).get("agent_result") or {}
                        if ar.get("cost_usd") is not None:
                            cost = float(ar["cost_usd"])
                        if ar.get("n_input_tokens"):
                            tin, tout = float(ar["n_input_tokens"]), float(ar.get("n_output_tokens") or 0)
                    rows.append((d.name, jr.parent.name, t.rsplit("__", 1)[0], t, y, exc.get(t), cost, tin, tout))
    df = pd.DataFrame(rows, columns=["system", "job", "task", "trial", "reward", "exception", "cost_usd",
                                     "tokens_in", "tokens_out"])
    assert set(df.reward.unique()) <= {0.0, 1.0}, df.reward.unique()
    df.attrs["dropped_jobs"] = dropped
    return df


def arm_names() -> list[str]:
    from .stage4_common import load_arms

    return load_arms().names


def tb2_matched(systems: pd.DataFrame | None = None, names: list[str] | None = None) -> pd.DataFrame:
    s = tb2_systems() if systems is None else systems
    names = arm_names() if names is None else names
    s = s.copy()
    s["matched"] = (s.status == "ok") & s.model.isin(names)
    return s


def trial_systems() -> list[str]:
    """Systems whose per-trial files are fetched for cost: every single-model system of a matched model + Terminus2."""
    s = tb2_matched()
    return sorted(s.loc[s.matched | (s.agent == SCAFFOLD), "system"])


# --------------------------------------------------------------------------------------------- target object
@dataclass
class Target:
    """Model x task outcomes on a target benchmark. draws[k][i] = array of 0/1 trial outcomes; costs likewise."""

    name: str
    models: list
    tasks: list
    draws: list  # [k][i] -> np.ndarray of 0/1
    costs: list  # [k][i] -> np.ndarray of $ (nan where absent)
    meta: dict = field(default_factory=dict)

    @property
    def P(self) -> np.ndarray:
        return np.array([[d.mean() for d in row] for row in self.draws])

    def cost_matrix(self) -> np.ndarray:
        """Mean $ per (model, task); a cell without any cost gets the model's median trial cost (declared imputation)."""
        out = np.full((len(self.models), len(self.tasks)), np.nan)
        for k, row in enumerate(self.costs):
            allc = np.concatenate([c[~np.isnan(c)] for c in row]) if row else np.array([])
            med = np.median(allc) if len(allc) else np.nan
            for i, c in enumerate(row):
                cc = c[~np.isnan(c)]
                out[k, i] = cc.mean() if len(cc) else med
        return out

    def cost_coverage(self) -> dict:
        return {m: {"trials": int(sum(len(c) for c in row)), "with_cost": int(sum((~np.isnan(c)).sum() for c in row))}
                for m, row in zip(self.models, self.costs)}

    def padded(self):
        """(K, n, Dmax) outcome and cost arrays plus n_draws (K, n); used by the trial-sampling environment."""
        K, n = len(self.models), len(self.tasks)
        D = max(len(d) for row in self.draws for d in row)
        Y = np.zeros((K, n, D))
        Kc = np.zeros((K, n, D))
        nd = np.zeros((K, n), int)
        cm = self.cost_matrix()
        for k in range(K):
            for i in range(n):
                d, c = self.draws[k][i], self.costs[k][i]
                nd[k, i] = len(d)
                Y[k, i, : len(d)] = d
                Kc[k, i, : len(d)] = np.where(np.isnan(c), cm[k, i], c)
        return Y, Kc, nd


def tb2_target(models: list[str], scaffold: str | None = SCAFFOLD, trials: pd.DataFrame | None = None,
               systems: pd.DataFrame | None = None) -> Target:
    """Target matrix over the given canonical models. scaffold=None pools every single-model system of the model."""
    s = tb2_matched() if systems is None else systems
    tr = tb2_trials() if trials is None else trials
    sysmap = {}
    for m in models:
        sel = s[(s.status == "ok") & (s.model == m)]
        if scaffold is not None:
            sel = sel[sel.agent == scaffold]
        sysmap[m] = sorted(sel.system)
    tasks = sorted(tr.task.unique())
    keep = []
    for t in tasks:  # a task is kept when every model has at least one kept trial on it
        if all(((tr.task == t) & tr.system.isin(sysmap[m])).any() for m in models):
            keep.append(t)
    # cost imputation (declared): a trial without cost_usd but with token counts gets tokens x the model's list price
    # (results/models.csv, stage 1; no cache discount: the runs that lack cost report no cache tokens). A trial with
    # neither stays nan; a model with no cost at all is excluded from the cost-aware objectives by stage5.
    prices = pd.read_csv(C.RESULTS / "models.csv").set_index("model")
    tr = tr.copy()
    tr["cost_source"] = np.where(tr.cost_usd.notna(), "reported", "none")
    sys_model = {sy: m for m in models for sy in sysmap[m]}
    mod = tr.system.map(sys_model)
    imp = tr.cost_usd.isna() & tr.tokens_in.notna() & mod.notna()
    pin = mod[imp].map(prices.input_per_m) / 1e6
    pout = mod[imp].map(prices.output_per_m) / 1e6
    tr.loc[imp, "cost_usd"] = tr.loc[imp, "tokens_in"] * pin + tr.loc[imp, "tokens_out"] * pout
    tr.loc[imp, "cost_source"] = "tokens x list price"
    g = {k: v for k, v in tr[tr.task.isin(keep)].groupby(["system", "task"])}
    draws, costs = [], []
    for m in models:
        dr, co = [], []
        for t in keep:
            parts = [g[(sy, t)] for sy in sysmap[m] if (sy, t) in g]
            df = pd.concat(parts)
            dr.append(df.reward.to_numpy(float))
            co.append(df.cost_usd.to_numpy(float))
        draws.append(dr)
        costs.append(co)
    src = tr[tr.system.isin(sys_model)].groupby([tr.system.map(sys_model), "cost_source"]).size()
    return Target(f"tb2_{scaffold or 'all'}", list(models), keep, draws, costs,
                  {"systems": sysmap, "tasks_total": len(tasks), "tasks_kept": len(keep),
                   "cost_source_trials": {f"{a} / {b}": int(n) for (a, b), n in src.items()}})


# --------------------------------------------------------------------------------------------- Multilingual
def ml_submissions() -> pd.DataFrame:
    rows = []
    for d in sorted(p for p in ML_DIR.iterdir() if p.is_dir()):
        meta = yaml.safe_load((d / "metadata.yaml").read_text())
        tm = (meta.get("tags") or {}).get("model") or []
        raw = tm[0] if len(tm) == 1 else "|".join(tm)
        rows.append({"submission": d.name, "models_raw": raw, "model": norm_model(raw) if len(tm) == 1 else None,
                     "agent": (meta.get("tags") or {}).get("agent"), "headline": (meta.get("info") or {}).get("resolved"),
                     "has_per_instance": (d / "per_instance_details.json").exists()})
    return pd.DataFrame(rows)


def ml_target(models: list[str]) -> Target:
    """Multilingual: one run per (model, task). The newest submission per model; tasks = the 300 of the dataset, a
    task missing from a submission's per_instance_details counts as unresolved with that model's median cost."""
    tasks = sorted(pd.read_parquet(ML_DIR / "tasks.parquet", columns=["instance_id"]).instance_id)
    subs = ml_submissions()
    draws, costs, used = [], [], {}
    for m in models:
        sub = subs[subs.model == m].sort_values("submission").iloc[-1].submission
        used[m] = sub
        det = json.loads((ML_DIR / sub / "per_instance_details.json").read_text())
        draws.append([np.array([float(bool((det.get(t) or {}).get("resolved", 0)))]) for t in tasks])
        costs.append([np.array([float((det.get(t) or {}).get("cost") or np.nan)]) for t in tasks])
    return Target("multilingual", list(models), tasks, draws, costs,
                  {"submissions": used, "missing_cells": {m: int(sum(t not in json.loads((ML_DIR / used[m] / "per_instance_details.json").read_text()) for t in tasks)) for m in models}})


def verified_source(models: list[str]):
    """Per matched model: Verified (stage 4 arm) outcomes (500,) and costs (500,), band, list price."""
    from .stage4_common import load_arms

    A = load_arms()
    idx = [A.names.index(m) for m in models]
    return A, idx
