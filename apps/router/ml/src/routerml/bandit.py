"""Stage 2, part C: online adaptation, simulated with bandit feedback.

Stream: the 12 repositories arrive one after another in a random order (one order per stream); inside a
repository, tasks come in created_at order. For each task the policy picks a tier and then observes ONLY that
tier's outcome: a 0/1 draw from the tier's soft label on the task (drawn up front with a fixed seed per stream,
so all policies face the same draws; the `Env` object hands out only the chosen arm's draw). 200 streams.
Costs: every policy knows the tier price list in the form of the mean per-task cost of each tier on the OTHER
repositories (a public price table); the realised cost is the task's mean cost in the chosen tier.

Objectives (declared before running):
  (1) maximise quality - lambda * cost (cost in $ per task), lambda in LAMBDAS;
  (2) minimise cost subject to quality >= 95 % of always-high (target = 0.95 x always-high's quality on the
      other repositories), simple Lagrangian / threshold versions.
Evaluation uses expected values (soft labels S and mean costs K of the chosen tier), not the sampled draws.

Policies: fixed tiers; global prior (best fixed tier on the other repositories); Thompson sampling and UCB per
repository, flat start and empirical-Bayes start (Beta prior with the other repositories' tier mean and a
strength fitted from the between-repository variance of the other repositories); one Thompson sampler shared by
the whole stream (no prior); for (2): the offline mixture from the other repositories, a Lagrangian Thompson
sampler (dual ascent on the quality constraint) and a threshold rule (cheapest tier whose EB posterior mean
>= tau; tau adapted by Robbins-Monro on the observed quality gap).
Regret: against (i) the best fixed tier per repository in hindsight and (ii) the best fixed tier over all tasks.
"""

from __future__ import annotations

import time

import numpy as np

from . import config as C
from .ceiling import costs, shares
from .evaluate import curve_metrics, fixed_points, utility_points
from .stage2 import ci, load_matrix, save

N_STREAMS = 200
LAMBDAS = (0.0, 0.25, 0.4, 0.5, 0.6, 0.75, 1.0, 2.0)
TARGET = 0.95


class Env:
    """Bandit environment: holds every arm's pre-drawn outcome, returns only the chosen arm's."""

    def __init__(self, Y_all: np.ndarray, Kc: np.ndarray):
        self._Y = Y_all  # (n_streams, n_task, 3)
        self._K = Kc  # (n_task, 3)
        self.log = []

    def pull(self, task: np.ndarray, arm: np.ndarray):
        s = np.arange(len(task))
        self.log.append((task.copy(), arm.copy()))
        return self._Y[s, task, arm], self._K[task, arm]


# ----------------------------------------------------------------------------------- priors (leave-repo-out)
def repo_priors(S, K, repo_id, n_repo):
    """Per held-out repository: tier means m, cost means c, EB strength n0 (from the other repositories)."""
    m = np.zeros((n_repo, 3))
    c = np.zeros((n_repo, 3))
    n0 = np.zeros((n_repo, 3))
    for r in range(n_repo):
        o = repo_id != r
        m[r], c[r] = S[o].mean(0), K[o].mean(0)
        reps = [q for q in range(n_repo) if q != r]
        means = np.array([S[repo_id == q].mean(0) for q in reps])
        ns = np.array([(repo_id == q).sum() for q in reps])
        within = np.array([S[repo_id == q].var(0) / (repo_id == q).sum() for q in reps])
        vb = np.maximum(np.average((means - m[r]) ** 2, axis=0, weights=ns) - np.average(within, axis=0, weights=ns), 1e-4)
        n0[r] = np.clip(m[r] * (1 - m[r]) / vb - 1, 2, 500)
    return m, c, n0


# ----------------------------------------------------------------------------------- policies
class Policy:
    name = "policy"

    def __init__(self, ctx, rng):
        self.ctx, self.rng = ctx, rng

    def choose(self, repo):  # repo: (n_streams,) repository index of the current task
        raise NotImplementedError

    def update(self, repo, arm, y):
        pass


class Fixed(Policy):
    def __init__(self, ctx, rng, arm):
        super().__init__(ctx, rng)
        self.arm, self.name = arm, f"fixed_{C.TIERS[arm]}"

    def choose(self, repo):
        return np.full(len(repo), self.arm)


class GlobalPrior(Policy):
    name = "global_prior"

    def choose(self, repo):
        m, c, lam = self.ctx["m"][repo], self.ctx["c"][repo], self.ctx["lam"]
        return np.argmax(m - lam * c, 1)


class Beta(Policy):
    """Per-repository (or stream-wide) Beta posteriors; Thompson sampling or UCB on p - lambda c."""

    def __init__(self, ctx, rng, kind="ts", eb=False, shared=False):
        super().__init__(ctx, rng)
        ns, nr = ctx["n_streams"], ctx["n_repo"]
        self.kind, self.eb, self.shared = kind, eb, shared
        self.name = f"{kind}_{'stream' if shared else 'repo'}_{'eb' if eb else 'flat'}"
        nrr = 1 if shared else nr
        if eb:
            a0 = ctx["m"] * ctx["n0"]
            b0 = (1 - ctx["m"]) * ctx["n0"]
            self.a = np.broadcast_to(a0, (ns, nr, 3)).copy()
            self.b = np.broadcast_to(b0, (ns, nr, 3)).copy()
        else:
            self.a = np.ones((ns, nrr, 3))
            self.b = np.ones((ns, nrr, 3))
        self.n = np.zeros((ns, nrr, 3))
        self.t = np.zeros((ns, nrr))

    def _r(self, repo):
        return np.zeros_like(repo) if self.shared else repo

    def score(self, repo):
        s = np.arange(len(repo))
        r = self._r(repo)
        a, b = self.a[s, r], self.b[s, r]
        if self.kind == "ts":
            return self.rng.beta(a, b)
        mean = a / (a + b)
        n = self.n[s, r]
        tot = self.t[s, r][:, None] + 1
        bonus = np.sqrt(2 * np.log(tot) / np.maximum(n + (a + b - 2 if self.eb else 0), 1e-9))
        bonus = np.where((n == 0) & (not self.eb), 1e3, bonus)
        return mean + bonus

    def choose(self, repo):
        c = self.ctx["c"][repo]
        return np.argmax(self.score(repo) - self.ctx["lam"] * c, 1)

    def update(self, repo, arm, y):
        s = np.arange(len(repo))
        r = self._r(repo)
        self.a[s, r, arm] += y
        self.b[s, r, arm] += 1 - y
        self.n[s, r, arm] += 1
        self.t[s, r] += 1


class OfflineMixture(Policy):
    """Constrained (2): cheapest randomized mix of fixed tiers reaching TARGET x high on the other repositories."""

    name = "offline_mixture_95"

    def choose(self, repo):
        m, c = self.ctx["m"][repo], self.ctx["c"][repo]
        out = np.empty(len(repo), int)
        for i in range(len(repo)):
            out[i] = self._mix(m[i], c[i])
        return out

    def _mix(self, m, c):
        target = TARGET * m[2]
        best = (np.inf, None)
        for lo in range(3):
            for hi in range(3):
                if m[hi] < target or m[lo] > m[hi]:
                    continue
                w = 1.0 if m[lo] >= target else (target - m[lo]) / (m[hi] - m[lo])
                w = min(max(w, 0.0), 1.0)
                cost = (1 - w) * c[lo] + w * c[hi] if m[lo] < target else c[lo]
                if cost < best[0]:
                    best = (cost, (lo, hi, w if m[lo] < target else 0.0))
        lo, hi, w = best[1]
        return hi if self.rng.random() < w else lo


class LagrangianTS(Beta):
    """Constrained (2): a = argmax(mu * p_sample - c); mu <- max(0, mu + eta (target - y)) per stream."""

    def __init__(self, ctx, rng):
        super().__init__(ctx, rng, kind="ts", eb=True)
        self.name = "lagrangian_ts_eb"
        ns = ctx["n_streams"]
        self.mu = np.full(ns, ctx["mu0"])
        self.eta = ctx["mu0"] * 0.05

    def choose(self, repo):
        c = self.ctx["c"][repo]
        return np.argmax(self.mu[:, None] * self.score(repo) - c, 1)

    def update(self, repo, arm, y):
        super().update(repo, arm, y)
        target = TARGET * self.ctx["m"][repo, 2]
        self.mu = np.maximum(0.0, self.mu + self.eta * (target - y))


class ThresholdEB(Beta):
    """Constrained (2): cheapest tier whose EB posterior mean >= tau; tau <- tau + eta (target - y)."""

    def __init__(self, ctx, rng):
        super().__init__(ctx, rng, kind="mean", eb=True)
        self.name = "threshold_eb"
        self.tau = TARGET * ctx["m"][:, 2].mean() * np.ones(ctx["n_streams"])

    def choose(self, repo):
        s = np.arange(len(repo))
        p = self.a[s, repo] / (self.a[s, repo] + self.b[s, repo])
        ok = p >= self.tau[:, None]
        return np.where(ok.any(1), ok.argmax(1), 2)

    def update(self, repo, arm, y):
        super().update(repo, arm, y)
        target = TARGET * self.ctx["m"][repo, 2]
        self.tau = np.clip(self.tau + 0.01 * (target - y), 0, 1)


# ----------------------------------------------------------------------------------- simulation
def make_streams(tasks, n_streams, seed):
    rng = np.random.default_rng(seed)
    repos = sorted(tasks["repo"].unique())
    repo_id = tasks["repo"].map({r: i for i, r in enumerate(repos)}).to_numpy()
    created = tasks["created_at"].to_numpy()
    by_repo = [np.where(repo_id == r)[0][np.argsort(created[repo_id == r], kind="stable")] for r in range(len(repos))]
    orders = np.array([np.concatenate([by_repo[r] for r in rng.permutation(len(repos))]) for _ in range(n_streams)])
    return repos, repo_id, orders


def simulate(policy_factory, S, Kc, repo_id, orders, Y_all, ctx, seed):
    rng = np.random.default_rng(seed)
    pol = policy_factory(ctx, rng)
    env = Env(Y_all, Kc)
    ns, nt = orders.shape
    arms = np.empty((ns, nt), int)
    for t in range(nt):
        task = orders[:, t]
        repo = repo_id[task]
        a = pol.choose(repo)
        y, _ = env.pull(task, a)
        pol.update(repo, a, y)
        arms[:, t] = a
    return pol.name, arms, env


def main():
    t0 = time.time()
    M = load_matrix()
    tier = M.tier_idx("A_model_terciles")
    rows = np.arange(len(tier))
    S, Kc = shares(M.R, rows, tier), costs(M.cost, rows, tier)
    repos, repo_id, orders = make_streams(M.tasks, N_STREAMS, C.SEED + 40)
    nr = len(repos)
    m, c, n0 = repo_priors(S, Kc, repo_id, nr)
    ydraw = np.random.default_rng(C.SEED + 41)
    Y_all = (ydraw.random((N_STREAMS, len(S), 3)) < S[None]).astype(float)
    ns, nt = orders.shape
    pos_in_repo = np.zeros_like(orders)
    for s in range(ns):
        rr = repo_id[orders[s]]
        cnt = {}
        for t in range(nt):
            pos_in_repo[s, t] = cnt.get(rr[t], 0)
            cnt[rr[t]] = pos_in_repo[s, t] + 1
    ch = Kc[:, 2].sum()
    res = {"method": __doc__, "n_streams": N_STREAMS, "lambdas": LAMBDAS, "scheme": "A_model_terciles",
           "repositories": repos, "eb_strength_n0_mean_over_heldout_repos": {C.TIERS[t]: float(n0[:, t].mean()) for t in range(3)},
           "lambda_objective": {}, "constrained_95": {}}
    base_ctx = {"m": m, "c": c, "n0": n0, "n_streams": ns, "n_repo": nr}
    factories = {
        "fixed_low": lambda ctx, rng: Fixed(ctx, rng, 0), "fixed_mid": lambda ctx, rng: Fixed(ctx, rng, 1),
        "fixed_high": lambda ctx, rng: Fixed(ctx, rng, 2), "global_prior": GlobalPrior,
        "ts_repo_flat": lambda ctx, rng: Beta(ctx, rng, "ts", False), "ts_repo_eb": lambda ctx, rng: Beta(ctx, rng, "ts", True),
        "ucb_repo_flat": lambda ctx, rng: Beta(ctx, rng, "ucb", False), "ucb_repo_eb": lambda ctx, rng: Beta(ctx, rng, "ucb", True),
        "ts_stream_flat": lambda ctx, rng: Beta(ctx, rng, "ts", False, shared=True),
    }
    regret_curves = {}
    for lam in LAMBDAS:
        ctx = base_ctx | {"lam": lam}
        R = S - lam * Kc  # expected reward per task and tier
        best_repo = np.array([np.argmax(R[repo_id == r].sum(0)) for r in range(nr)])
        best_global = int(np.argmax(R.sum(0)))
        out = {"best_fixed_tier_global": C.TIERS[best_global],
               "best_fixed_tier_per_repo": {repos[r]: C.TIERS[best_repo[r]] for r in range(nr)}}
        for k, f in factories.items():
            name, arms, _ = simulate(f, S, Kc, repo_id, orders, Y_all, ctx, C.SEED + 42)
            task = orders
            got = R[task, arms]
            reg_repo = R[task, best_repo[repo_id[task]]] - got
            reg_glob = R[task, best_global] - got
            q = S[task, arms].mean(1)
            cost_rel = Kc[task, arms].sum(1) / ch
            bins = {"pos_0_9": pos_in_repo < 10, "pos_10_49": (pos_in_repo >= 10) & (pos_in_repo < 50), "pos_50_plus": pos_in_repo >= 50}
            out[k] = {"cum_regret_vs_best_tier_per_repo": ci(reg_repo.sum(1)), "cum_regret_vs_global_best_tier": ci(reg_glob.sum(1)),
                      "mean_reward_per_task": ci(got.mean(1)), "quality": ci(q), "cost_rel_high": ci(cost_rel),
                      "regret_per_task_by_position_in_repo_vs_repo_best": {b: float(reg_repo[msk].mean()) for b, msk in bins.items()},
                      "tier_share": {C.TIERS[t]: float((arms == t).mean()) for t in range(3)}}
            # tasks until within margin: first position-in-repo after which the mean per-task regret vs the
            # repository's best tier stays <= 0.01 (averaged over streams and repositories)
            maxpos = pos_in_repo.max() + 1
            per_pos = np.array([reg_repo[pos_in_repo == p].mean() for p in range(maxpos)])
            sm = np.convolve(per_pos, np.ones(5) / 5, mode="same")
            bad = np.where(sm > 0.01)[0]
            out[k]["tasks_until_within_0.01_per_task_vs_repo_best"] = int(bad.max() + 1) if len(bad) else 0
            if lam == 0.5:
                regret_curves[k] = (reg_repo.cumsum(1).mean(0), reg_glob.cumsum(1).mean(0))
        res["lambda_objective"][str(lam)] = out
        print("lambda", lam, round(time.time() - t0), "s", flush=True)
    # constrained objective
    mu0 = np.median([(c[r, 2] - c[r, 0]) / max(m[r, 2] - m[r, 0], 1e-3) for r in range(nr)])
    ctx = base_ctx | {"lam": 0.0, "mu0": mu0}
    cons = {"mu0": float(mu0)}
    for k, f in {"fixed_high": lambda ctx, rng: Fixed(ctx, rng, 2), "offline_mixture_95": OfflineMixture,
                 "lagrangian_ts_eb": LagrangianTS, "threshold_eb": ThresholdEB}.items():
        name, arms, _ = simulate(f, S, Kc, repo_id, orders, Y_all, ctx, C.SEED + 43)
        q = S[orders, arms].mean(1)
        qh = S[orders, 2].mean(1)
        cons[k] = {"quality_rel_high": ci(q / qh), "cost_rel_high": ci(Kc[orders, arms].sum(1) / ch),
                   "share_streams_meeting_95": float((q / qh >= TARGET).mean()),
                   "tier_share": {C.TIERS[t]: float((arms == t).mean()) for t in range(3)}}
    fx = fixed_points(S, Kc)
    cm = curve_metrics(fx, S, Kc)
    co = curve_metrics(utility_points(S, S, Kc, Kc), S, Kc)
    cons["offline_reference"] = {"mixture_cost_saved_at_95": cm["cost_saved_at_95"], "in_sample_oracle_saved_at_95": co["cost_saved_at_95"],
                                 "fixed": {C.TIERS[t]: {"cost_rel": float(fx[t, 0]), "quality": float(fx[t, 1])} for t in range(3)}}
    res["constrained_95"] = cons
    res["runtime_s"] = round(time.time() - t0)
    save("stage2_bandit.json", res)
    figure(res, regret_curves)
    print("done", res["runtime_s"], "s")


def figure(res, regret_curves):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axs = plt.subplots(1, 2, figsize=(12, 4.8))
    for ax, j, title in ((axs[0], 0, "vs best fixed tier per repository (hindsight)"), (axs[1], 1, "vs best fixed tier over all tasks")):
        for k, v in regret_curves.items():
            if k.startswith("fixed_low") or k.startswith("fixed_mid"):
                continue
            ax.plot(v[j], label=k)
        ax.set_title(f"Cumulative regret, lambda = 0.5 $^-1: {title}", fontsize=9)
        ax.set_xlabel("tasks in the stream")
        ax.set_ylabel("cumulative regret (expected quality - lambda cost)")
        ax.grid(color="#d0d7de", lw=0.6)
        ax.legend(frameon=False, fontsize=7)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage2_bandit.png", dpi=130)


if __name__ == "__main__":
    main()
