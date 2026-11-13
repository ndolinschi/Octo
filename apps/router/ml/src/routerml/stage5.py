"""Stage 5: does a ladder that learns online beat a ladder read off a public leaderboard when the router's own work ranks
models differently? One benchmark plays "the leaderboard" (SOURCE), another "the router's own traffic" (TARGET).

Everything below was declared before any stream was run; nothing is tuned on target outcomes.

Source = SWE-bench Verified, the stage 4 arm of each matched model (mini-SWE-agent, newest run, 500 tasks, one run per
cell, per-task cost). Targets (xbench_data):
  tb2_Terminus2  Terminal-Bench 2.0, the benchmark's reference agent Terminus 2 only (one scaffold); its models that
                 match the Verified core; per-trial draws (about 5 trials per task) and per-trial cost.
  tb2_all        the same benchmark, every single-model system of a matched model pooled (several scaffolds; the
                 model effect averaged over the scaffolds that submitted it).
  multilingual   SWE-bench Multilingual (300 tasks, 9 languages), mini-SWE-agent (the same scaffold as the source),
                 one run per cell, per-task cost.
Transfer (part 2): per matched model, solve rate and cost per solved on both sides; Spearman and Kendall of the solve
rates with 95 % intervals from 1000 bootstraps that resample source tasks and target tasks independently; the best
model per price band (stage 1's scheme-A band) on each side.

Streams (part 3). Feedback is bandit: per decision one model, and only a draw of that model's outcome and cost on that
task (TrialEnv: a trial picked uniformly from the cell's trials by the environment's own generator). Scores are the
EXPECTED reward of the chosen cell, p(model, task) - lambda x mean cost(model, task), which removes the draw noise from
the comparison (the learners still see only draws). lambda = 1 / V, V in {inf, $20, $5, $2, $1, $0.5, $0.2}.
  full design   tasks of the whole target: one pass (a random permutation, n tasks) and resampled long streams (tasks
                drawn with replacement, 500 and 2000 decisions). Resampling repeats the same tasks, so it overstates
                how much the future resembles the past; it is reported as such.
  split design  per stream a random half A of the target's tasks is "benchmarked" (full information) and the stream is
                drawn from the other half B (one pass of B; and 500 resampled from B). Only here the held-out-half
                baseline exists; every other policy ignores A (test: changing A's outcomes leaves their decisions
                unchanged; the held-out choice never reads B).
Policies:
  leaderboard_ladder  the matched model with the best source aggregate under the objective (solve rate - lambda x mean
                      cost on Verified); fixed; the production practice under test.
  target_oracle       the best fixed model on the stream's tasks in hindsight (regret reference).
  heldout_half        (split design) the best model on half A, used on half B.
  ts_flat             stage 4's cost-aware Thompson sampler, Beta(1, 1), cost prior list price x 0.5 M tokens.
  ts_src{n0}          the same with a Beta(n0 h + 0.5, n0 (1 - h) + 0.5) prior from the source solve rate h, n0 in
                      {5, 20, 50}, and a cost prior of one pseudo-observation at the source mean cost.
  eps_greedy          stage 4's (epsilon = 0.1).
  ts_flat_disc, ts_src20_disc   with forgetting (discount 0.99).
  uniform             a uniformly random model per decision (shows how much of a win is only "the ladder picked badly").
Metrics: expected reward per decision (mean over the stream); learner minus leaderboard ladder per stream (95 %
interval = percentiles over 200 streams); the decision after which the stream-averaged cumulative reward of the learner
stays above the ladder's ("overtakes", 2000-decision resampled streams); the same for the trailing 25-decision mean.
Reverse control: target = Verified (matched models), source = the TB2 Terminus 2 aggregate.
Break-even (part 4): on the target, the source solve rates are replaced by target rates + sigma x N(0, 1) (one draw
per stream), sigma in {0, 0.05, 0.1, 0.2, 0.3, 0.5}; the ladder and ts_src20 read that synthetic leaderboard; reported:
realised Spearman with the target, the ladder's regret, and learner - ladder at 89 / 500 / 2000 decisions.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import numpy as np
from scipy import stats

from . import config as C
from .stage2 import ci, save
from .stage4_ladder import TS, EpsGreedy, Fixed, Uniform, lam_of, vlabel
from .xbench_data import Target, ml_target, tb2_matched, tb2_systems, tb2_target, tb2_trials, verified_source

VALUES = (np.inf, 20.0, 5.0, 2.0, 1.0, 0.5, 0.2)
N0S = (5, 20, 50)
NS = 200
LONG = (500, 2000)
SIGMAS = (0.0, 0.05, 0.1, 0.2, 0.3, 0.5)
BAND_NAMES = ("low", "mid", "high")
SMOOTH = 25


# --------------------------------------------------------------------------------------------- environment
class TrialEnv:
    """Holds the padded trial arrays; returns one random trial of the chosen (model, task) cell only."""

    def __init__(self, Y, Kc, nd, orders, seed):
        self._Y, self._K, self._nd, self._o = Y, Kc, nd, orders
        self._rng = np.random.default_rng(seed)
        self.calls = 0

    def pull(self, t, arms):
        task = self._o[:, t]
        d = np.floor(self._rng.random(len(arms)) * self._nd[arms, task]).astype(int)
        self.calls += 1
        return self._Y[arms, task, d], self._K[arms, task, d]


class TSPrior(TS):
    """Stage 4 Thompson with a Beta prior of strength n0 from a source leaderboard (per stream or shared)."""

    def __init__(self, A, ns, T, lam, rng, n0, src_m, src_c, discount=None):
        super().__init__(A, ns, T, lam, rng, prior="informed", discount=discount)
        self.n0 = n0
        self.src_m = np.broadcast_to(src_m, (ns, self.K))
        self.src_c = np.broadcast_to(src_c, (ns, self.K))
        self.name = f"ts_src{n0}" + (f"_disc{discount}" if discount else "")

    def posterior(self):
        n, s, c = self.st.n, self.st.s, self.st.c
        a0 = self.n0 * self.src_m + 0.5
        b0 = self.n0 * (1 - self.src_m) + 0.5
        return a0 + s, b0 + (n - s), (self.src_c + c) / (1 + n), n


class FixedPerStream(Fixed):
    def choose(self, t, avail):
        return np.asarray(self.arm)


def simulate(pol, env, T):
    arms = np.empty((pol.ns, T), int)
    av = np.ones((pol.ns, pol.K), bool)
    for t in range(T):
        a = pol.choose(t, av)
        y, c = env.pull(t, a)
        pol.update(t, a, y, c)
        arms[:, t] = a
    return arms


# --------------------------------------------------------------------------------------------- setting
def setting(target, src_rate, src_cost, band, price):
    Y, Kc, nd = target.padded()
    P = target.P
    Cm = np.nan_to_num(target.cost_matrix())  # nan only for models without any cost; those run quality-only
    Kc = np.nan_to_num(Kc)
    A = SimpleNamespace(names=target.models, band=np.asarray(band), price=np.asarray(price, float))
    return SimpleNamespace(T=target, Y=Y, Kc=Kc, nd=nd, P=P, Cm=Cm, A=A, h=np.asarray(src_rate, float),
                           c=np.asarray(src_cost, float), K=len(target.models), n=len(target.tasks))


def learners(S, lam, ns, T, seed, src_m=None):
    src_m = S.h if src_m is None else src_m
    out = {
        "ts_flat": lambda: TS(S.A, ns, T, lam, np.random.default_rng(seed), prior="flat"),
        "eps_greedy": lambda: EpsGreedy(S.A, ns, T, lam, np.random.default_rng(seed)),
        "uniform": lambda: Uniform(S.A, ns, T, lam, np.random.default_rng(seed)),
        "ts_flat_disc": lambda: TS(S.A, ns, T, lam, np.random.default_rng(seed), prior="flat", discount=0.99),
        "ts_src20_disc": lambda: TSPrior(S.A, ns, T, lam, np.random.default_rng(seed), 20, src_m, S.c, discount=0.99),
    }
    for n0 in N0S:
        out[f"ts_src{n0}"] = (lambda n0=n0: TSPrior(S.A, ns, T, lam, np.random.default_rng(seed), n0, src_m, S.c))
    return out


def exp_reward(S, lam, arms, orders):
    return S.P[arms, orders] - lam * S.Cm[arms, orders]


def overtake(diff):
    """diff (ns, T): per-decision learner - ladder. First t after which the stream-mean cumulative sum stays > 0, and
    the first t after which the stream-mean trailing-25 mean stays > 0 (None if never by the end)."""
    m = diff.mean(0)
    cs = np.cumsum(m)
    bad = np.where(cs <= 0)[0]
    cum_t = None if len(bad) and bad.max() == len(m) - 1 else int(bad.max() + 2 if len(bad) else 1)
    c2 = np.concatenate([[0.0], cs])
    t = np.arange(1, len(c2))
    lo = np.maximum(t - SMOOTH, 0)
    tr = (c2[t] - c2[lo]) / (t - lo)
    bad = np.where(tr <= 0)[0]
    inst_t = None if len(bad) and bad.max() == len(m) - 1 else int(bad.max() + 2 if len(bad) else 1)
    return {"cumulative": cum_t, "trailing25": inst_t, "final_trailing25_diff": float(tr[-1])}


def run_design(S, lam, orders, seed, extra_fixed=None, src_m=None, which=None):
    """orders (ns, T) task indices. Returns per-policy per-stream mean expected reward and per-decision rewards."""
    ns, T = orders.shape
    env_seed = seed + 7
    res, per = {}, {}
    ladder = int(np.argmax(S.h - lam * S.c)) if src_m is None else None
    if src_m is None:
        arms = np.full((ns, T), ladder)
    else:
        lad = (src_m - lam * S.c[None]).argmax(1)
        arms = np.repeat(lad[:, None], T, 1)
    per["leaderboard_ladder"] = exp_reward(S, lam, arms, orders)
    mu = np.stack([exp_reward(S, lam, np.full((ns, T), k), orders).mean(1) for k in range(S.K)], 1)  # (ns, K)
    per_or = mu.argmax(1)
    per["target_oracle"] = exp_reward(S, lam, np.repeat(per_or[:, None], T, 1), orders)
    for name, arm in (extra_fixed or {}).items():
        per[name] = exp_reward(S, lam, np.repeat(np.asarray(arm)[:, None], T, 1), orders)
    for name, fac in learners(S, lam, ns, T, seed, src_m).items():
        if which is not None and name not in which:
            continue
        pol = fac()
        a = simulate(pol, TrialEnv(S.Y, S.Kc, S.nd, orders, env_seed), T)
        per[name] = exp_reward(S, lam, a, orders)
        res.setdefault("_arms", {})[name] = a
    lad = per["leaderboard_ladder"]
    out = {"mean_reward": {k: ci(v.mean(1)) for k, v in per.items()},
           "minus_leaderboard_ladder": {k: ci((v - lad).mean(1)) for k, v in per.items() if k != "leaderboard_ladder"},
           "share_streams_learner_beats_ladder": {k: float(((v - lad).mean(1) > 0).mean()) for k, v in per.items()
                                                  if k.startswith(("ts_", "eps", "uniform"))},
           "oracle_model_modal": S.T.models[int(np.bincount(per_or, minlength=S.K).argmax())],
           "oracle_model_share": float(np.bincount(per_or, minlength=S.K).max() / ns)}
    if ladder is not None:
        out["ladder_model"] = S.T.models[ladder]
    return out, per


def fixed_table(S, lam):
    mu_t = (S.P - lam * S.Cm).mean(1)
    mu_s = S.h - lam * S.c
    return {"source_best": S.T.models[int(mu_s.argmax())], "target_best": S.T.models[int(mu_t.argmax())],
            "ladder_target_reward": float(mu_t[int(mu_s.argmax())]), "target_best_reward": float(mu_t.max()),
            "ladder_regret_per_task": float(mu_t.max() - mu_t[int(mu_s.argmax())]),
            "target_reward_by_model": {m: float(x) for m, x in zip(S.T.models, mu_t)}}


def streams(S, seed):
    rng = np.random.default_rng(seed)
    full = {"one_pass": np.array([rng.permutation(S.n) for _ in range(NS)])}
    for H in LONG:
        full[f"resampled_{H}"] = rng.integers(0, S.n, (NS, H))
    inA = np.array([rng.permutation(S.n) < S.n // 2 for _ in range(NS)])
    B = [np.where(~m)[0] for m in inA]
    nb = min(len(b) for b in B)
    split = {"one_pass_B": np.array([rng.permutation(b)[:nb] for b in B]),
             "resampled_B_500": np.array([b[rng.integers(0, len(b), 500)] for b in B])}
    return full, split, inA


def heldout_choice(P, Cm, lam, inA):
    """Per stream the best model on half A only (the columns of B are never read)."""
    return np.array([(P[:, m] - lam * Cm[:, m]).mean(1).argmax() for m in inA])


def experiment(S, seed, values=VALUES, with_split=True, which=None):
    full, split, inA = streams(S, seed)
    out = {}
    curves = {}
    for v in values:
        lam = lam_of(v)
        e = {"fixed": fixed_table(S, lam)}
        for hname, od in full.items():
            r, per = run_design(S, lam, od, seed + 11, which=which)
            if hname == "resampled_2000":
                lad = per["leaderboard_ladder"]
                r["overtake"] = {k: overtake(per[k] - lad) for k in per if k.startswith(("ts_", "eps", "uniform"))}
                if np.isinf(v) or v == 1.0:
                    curves[vlabel(v)] = {k: np.cumsum((per[k] - lad).mean(0)) / np.arange(1, od.shape[1] + 1)
                                         for k in ("ts_flat", "ts_src20", "uniform", "target_oracle") if k in per}
            e[hname] = r
        if with_split:
            # held-out half: best on half A (full information, A only), used on B.
            ho = heldout_choice(S.P, S.Cm, lam, inA)
            for hname, od in split.items():
                r, _ = run_design(S, lam, od, seed + 13, extra_fixed={"heldout_half": ho}, which=which)
                e[hname] = r
        out[vlabel(v)] = e
    return out, curves


# --------------------------------------------------------------------------------------------- transfer (part 2)
def transfer(models, src_R, src_C, S, band, seed):
    """src_R/src_C (K, 500) Verified; S target. Solve rates, Spearman/Kendall with a two-sided task bootstrap."""
    hs, ht = src_R.mean(1), S.P.mean(1)
    rng = np.random.default_rng(seed)
    sp, kd, same_best = [], [], []
    for _ in range(C.N_BOOT):
        i = rng.integers(0, src_R.shape[1], src_R.shape[1])
        j = rng.integers(0, S.n, S.n)
        a, b = src_R[:, i].mean(1), S.P[:, j].mean(1)
        sp.append(stats.spearmanr(a, b).statistic)
        kd.append(stats.kendalltau(a, b).statistic)
        same_best.append(a.argmax() == b.argmax())
    q = lambda x: [float(np.nanpercentile(x, 2.5)), float(np.nanpercentile(x, 97.5))]
    cs = src_C.mean(1) / np.maximum(hs, 1e-9)
    ct = S.Cm.mean(1) / np.maximum(ht, 1e-9)
    per_model = {m: {"band": BAND_NAMES[band[k]], "source_rate": float(hs[k]), "target_rate": float(ht[k]),
                     "source_rank": int((-hs).argsort().argsort()[k] + 1), "target_rank": int((-ht).argsort().argsort()[k] + 1),
                     "source_cost_per_task": float(src_C[k].mean()), "target_cost_per_task": float(S.Cm[k].mean()),
                     "source_cost_per_solved": float(cs[k]), "target_cost_per_solved": float(ct[k])}
                 for k, m in enumerate(models)}
    best_band = {}
    for b in range(3):
        idx = np.where(np.asarray(band) == b)[0]
        if len(idx):
            best_band[BAND_NAMES[b]] = {
                "source_best_rate": models[idx[hs[idx].argmax()]], "target_best_rate": models[idx[ht[idx].argmax()]],
                "source_best_cost_per_solved": models[idx[cs[idx].argmin()]],
                "target_best_cost_per_solved": models[idx[ct[idx].argmin()]], "n_models": int(len(idx))}
    return {"n_models": len(models), "spearman": {"point": float(stats.spearmanr(hs, ht).statistic), "ci": q(sp)},
            "kendall": {"point": float(stats.kendalltau(hs, ht).statistic), "ci": q(kd)},
            "spearman_cost_per_solved": float(stats.spearmanr(cs, ct).statistic),
            "best_rate_model": {"source": models[int(hs.argmax())], "target": models[int(ht.argmax())],
                                "bootstrap_share_same": float(np.mean(same_best))},
            "best_per_band": best_band, "per_model": per_model}


# --------------------------------------------------------------------------------------------- break-even (part 4)
def breakeven(S, seed, values=(np.inf, 1.0)):
    out = {}
    rng = np.random.default_rng(seed)
    ht = S.P.mean(1)
    full, _, _ = streams(S, seed)
    for v in values:
        lam = lam_of(v)
        mu_t = (S.P - lam * S.Cm).mean(1)
        e = {}
        for sg in SIGMAS:
            src = np.clip(ht[None] + sg * rng.standard_normal((NS, S.K)), 0.01, 0.99)
            rho = [stats.spearmanr(s, ht).statistic if sg > 0 else 1.0 for s in src]
            lad = (src - lam * S.c[None]).argmax(1)
            r = {"realised_spearman_mean": float(np.nanmean(rho)),
                 "ladder_regret_per_task_mean": float((mu_t.max() - mu_t[lad]).mean()),
                 "share_ladder_on_target_best": float((lad == mu_t.argmax()).mean())}
            for hname, od in full.items():
                res, per = run_design(S, lam, od, seed + 17, src_m=src, which=("ts_src20", "ts_flat"))
                r[hname] = {k: res["minus_leaderboard_ladder"][k] for k in ("ts_src20", "ts_flat")}
            e[f"sigma={sg}"] = r
        out[vlabel(v)] = e
    return out


# --------------------------------------------------------------------------------------------- main
def build_targets():
    trials = tb2_trials()
    systems = tb2_matched(tb2_systems())
    A, _ = verified_source([])
    names = A.names
    t2 = systems[(systems.agent == "Terminus2") & (systems.status == "ok")]
    m_t2 = sorted(set(t2.model) & set(names))
    m_all = sorted(set(systems.loc[systems.matched, "model"]))
    return trials, systems, {"tb2_Terminus2": tb2_target(m_t2, "Terminus2", trials, systems),
                             "tb2_all": tb2_target(m_all, None, trials, systems)}


def source_for(models):
    A, idx = verified_source(models)
    return A, idx, A.R[idx], A.Kc[idx], A.band[idx], A.price[idx]


def main():
    t0 = time.time()
    trials, systems, targets = build_targets()
    from .xbench_data import ml_submissions

    ml = ml_submissions()
    A, _ = verified_source([])
    ml_models = sorted(set(ml.model.dropna()) & set(A.names))
    targets["multilingual"] = ml_target(ml_models)
    res = {"method": __doc__, "sources": {"tb2": {"repo": C.TB2_REPO, "revision": C.TB2_REVISION},
                                          "multilingual_tasks": {"repo": C.ML_DATASET, "revision": C.ML_REVISION},
                                          "outcomes": {"repo": C.EXPERIMENTS_URL, "commit": C.EXPERIMENTS_COMMIT}},
           "matching": {"tb2_systems": systems.to_dict("records"),
                        "multilingual": ml.to_dict("records"),
                        "dropped_jobs": trials.attrs.get("dropped_jobs")},
           "targets": {}}
    for tname in list(targets):  # models without any cost: quality-only on all; cost-aware objectives on the rest
        T = targets[tname]
        cov = T.cost_coverage()
        keep = [k for k, m in enumerate(T.models) if cov[m]["with_cost"] > 0]
        if 0 < len(keep) < len(T.models):
            targets[tname + "_costed"] = Target(T.name + "_costed", [T.models[k] for k in keep], T.tasks,
                                                [T.draws[k] for k in keep], [T.costs[k] for k in keep],
                                                T.meta | {"dropped_no_cost": [m for m in T.models if cov[m]["with_cost"] == 0]})
    curves_all = {}
    for tname, T in targets.items():
        Asrc, idx, R, Kc, band, price = source_for(T.models)
        S = setting(T, R.mean(1), Kc.mean(1), band, price)
        cov = T.cost_coverage()
        info = {"models": T.models, "n_tasks": S.n, "meta": T.meta, "cost_coverage": cov,
                "trials_per_cell": {"min": int(S.nd.min()), "median": float(np.median(S.nd)), "max": int(S.nd.max())}}
        has_cost = all(c["with_cost"] > 0 for c in cov.values())
        values = VALUES if has_cost else (np.inf,)
        info["objectives"] = [vlabel(v) for v in values]
        info["transfer"] = transfer(T.models, R, Kc, S, band, C.SEED + 500)
        print(tname, "transfer", round(time.time() - t0), "s", flush=True)
        info["streams"], curves = experiment(S, C.SEED + 510, values)
        curves_all[tname] = curves
        print(tname, "streams", round(time.time() - t0), "s", flush=True)
        if tname in ("tb2_Terminus2", "tb2_Terminus2_costed", "multilingual"):
            info["breakeven"] = breakeven(S, C.SEED + 520, values=(np.inf, 1.0) if has_cost else (np.inf,))
            print(tname, "breakeven", round(time.time() - t0), "s", flush=True)
        res["targets"][tname] = info
        save("stage5_xbench.json", strip(res))
    # reverse control: target = Verified (the matched Terminus 2 models), source = the TB2 Terminus 2 aggregate
    res["reverse_control"] = {}
    for tname in ("tb2_Terminus2", "tb2_Terminus2_costed"):
        if tname not in targets:
            continue
        T2 = targets[tname]
        Asrc, idx, R, Kc, band, price = source_for(T2.models)
        V = Target("verified_rev", T2.models, list(range(R.shape[1])),
                   [[np.array([R[k, i]]) for i in range(R.shape[1])] for k in range(len(idx))],
                   [[np.array([Kc[k, i]]) for i in range(R.shape[1])] for k in range(len(idx))])
        S2 = setting(T2, np.zeros(len(idx)), np.zeros(len(idx)), band, price)
        Srev = setting(V, S2.P.mean(1), S2.Cm.mean(1), band, price)
        values = VALUES if all(c["with_cost"] > 0 for c in T2.cost_coverage().values()) else (np.inf,)
        rev, _ = experiment(Srev, C.SEED + 530, values, with_split=False,
                            which=("ts_flat", "ts_src5", "ts_src20", "ts_src50", "eps_greedy", "uniform"))
        res["reverse_control"][tname] = {"models": T2.models, "streams": rev}
        print("reverse", tname, round(time.time() - t0), "s", flush=True)
    res["runtime_s"] = round(time.time() - t0)
    save("stage5_xbench.json", strip(res))
    figures(res, curves_all)
    print("done", res["runtime_s"], "s")


def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k != "_arms"}
    if isinstance(o, list):
        return [strip(v) for v in o]
    return o


def figures(res, curves_all):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    tn = list(res["targets"])
    fig, axs = plt.subplots(1, len(tn), figsize=(5.2 * len(tn), 4.8))
    for ax, t in zip(np.atleast_1d(axs), tn):
        pm = res["targets"][t]["transfer"]["per_model"]
        x = [d["source_rate"] for d in pm.values()]
        y = [d["target_rate"] for d in pm.values()]
        ax.scatter(x, y, s=22, color="#2a6fdb")
        for m, xi, yi in zip(pm, x, y):
            ax.annotate(m, (xi, yi), fontsize=6.5, xytext=(3, 2), textcoords="offset points")
        tr = res["targets"][t]["transfer"]
        ax.set_title(f"{t}: Spearman {tr['spearman']['point']:.2f} "
                     f"[{tr['spearman']['ci'][0]:.2f}, {tr['spearman']['ci'][1]:.2f}]", fontsize=9)
        ax.set_xlabel("solve rate on SWE-bench Verified (source)")
        ax.set_ylabel("solve rate on target")
        ax.grid(color="#d0d7de", lw=0.6)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage5_rank_scatter.png", dpi=130)
    plt.close(fig)

    pols = ("target_oracle", "leaderboard_ladder", "ts_flat", "ts_src5", "ts_src20", "ts_src50", "eps_greedy", "ts_flat_disc")
    fig, axs = plt.subplots(1, len(tn), figsize=(5.2 * len(tn), 4.6))
    for ax, t in zip(np.atleast_1d(axs), tn):
        st = res["targets"][t]["streams"]
        vs = list(st)
        for j, p in enumerate(pols):
            ys = [st[v]["resampled_500"]["mean_reward"][p]["mean"] for v in vs]
            ax.plot(range(len(vs)), ys, marker="o", ms=3, lw=1.2, label=p, ls="--" if p in ("target_oracle", "leaderboard_ladder") else "-")
        ax.set_xticks(range(len(vs)), vs, fontsize=7, rotation=30)
        ax.set_title(f"{t}: expected reward per decision (500 resampled)", fontsize=9)
        ax.grid(color="#d0d7de", lw=0.6)
    np.atleast_1d(axs)[0].legend(frameon=False, fontsize=7)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage5_reward_by_policy.png", dpi=130)
    plt.close(fig)

    fig, axs = plt.subplots(1, len(tn), figsize=(5.2 * len(tn), 4.4))
    for ax, t in zip(np.atleast_1d(axs), tn):
        for v, cc in curves_all.get(t, {}).items():
            for k, y in cc.items():
                ax.plot(np.arange(1, len(y) + 1), y, lw=1.2, label=f"{k} {v}", ls="-" if v == "V=$1" else ":")
        ax.axhline(0, color="k", lw=0.6)
        ax.set_xscale("log")
        ax.set_xlabel("decisions (resampled stream)")
        ax.set_ylabel("cumulative mean reward minus leaderboard ladder")
        ax.set_title(t, fontsize=9)
        ax.grid(color="#d0d7de", lw=0.6)
        ax.legend(frameon=False, fontsize=6.5)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage5_learner_vs_ladder.png", dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    main()
