"""Stage 4, L1: a ladder that learns itself (criterion 2').

Setting (declared before running). 33 arms = concrete models (stage4_common.load_arms). A stream presents the 500
Verified tasks one at a time (orders: random / by repository / by created_at, 200 streams each). Per task the policy
picks ONE model and observes only that model's resolved (0/1) and cost ($) on that task: the Env object holds the
matrix and hands out only the chosen cell (test: tests/test_stage4.py flips every cell the policy did not choose and
asserts identical decisions).

Objectives:
  (i) reward = solved - lambda * cost. lambda = 1 / V, V = the value of one solved task in $:
      V in {inf (quality only), $20, $5, $2, $1, $0.5, $0.2}  ("quality first" -> "cost first"). For scale: mean cost
      per task ranges $0.03-$1.13 over the arms, solve rate 0.09-0.77.
  (ii) minimum cost subject to quality >= q x (best model's solve rate), q in {0.90, 0.95}.

Policies (all hyper-parameters fixed here, none tuned on outcomes):
  ts_flat      Thompson: Beta(1, 1) on success; cost: posterior mean c_hat = (c0 + sum c) / (1 + n), sampled as
               c_hat * exp(0.8 z / sqrt(1 + n)); c0 = list price x T0, T0 = 0.5 M tokens per task (a nominal).
  ts_band      the same with an empirical-Bayes start shared by a price band: model j's prior is
               Beta(4 m, 4 (1 - m)), m = the pooled success rate of the OTHER models of j's band observed so far in this
               stream (Laplace-smoothed); its cost prior is list price x the band's pooled tokens per task (observed
               cost / list price of the other band members). Uses no data outside the stream.
  ucb          UCB1 on success (sqrt(2 ln t / n)) and an optimistic cost c_hat * exp(-0.8 sqrt(2 ln t / (1 + n))).
  succ_elim    successive elimination: round-robin over active arms, drop an arm when its upper bound on mean reward is
               below the best lower bound (Hoeffding, delta = 0.05, reward range 1 + 2 lambda).
  eps_greedy   epsilon = 0.1, greedy on the empirical mean reward, unpulled arms first (the naive baseline).
  uniform      a uniformly random model per task.
  ts_informed  (split experiment only) Beta(20 h + 0.5, 20 (1 - h) + 0.5) and cost prior = mean cost, where h and the
               mean cost are each model's aggregate on a random half A of the tasks (an out-of-sample "leaderboard");
               the stream is the other half B (250 tasks, random order). Compared there with the leaderboard ladder
               built from half A (the half-A best model at that lambda, and the half-A best per band) and ts_flat.
  For (ii): ts_flat / ts_band choose the cheapest sampled-cost arm whose sampled success >= q x the largest sampled
  success.
Baselines that mirror production (no learning):
  list-price ladder   low = the cheapest listed model of the low band, mid = the cheapest of the mid band, high = the
                      dearest of the high band. For (i) the best of the three rungs AT THAT lambda in hindsight (generous
                      to the baseline); for (ii) the cheapest rung whose headline >= q x best headline.
  leaderboard ladder  per band the model with the best public headline solve rate; same use. INFORMATION: the headline
                      is the mean of the same 500 outcomes (an in-sample aggregate), so on this data this baseline is
                      close to hindsight model selection by band. Also "leaderboard $/solved": per band the best
                      published mean cost / headline (the production ladder's own rule, "DeepSWE $/score").
  best fixed model in hindsight (the regret reference, per lambda), uniform random.
Metrics: cumulative realized regret vs the best fixed model in hindsight (same tasks); pseudo-regret per decision
(mu* - mu_a, mu = the arm's mean reward over all 500 tasks); tasks until the stream-averaged per-decision
pseudo-regret (trailing 25-task window) stays below m = 0.02 / 0.05 for the rest of the stream (interval: 1000 stream
bootstraps); final solve rate and cost per solved task; exploration cost in $ and in solves vs the hindsight-best model.
Tier view: TS-flat's posterior after N = 100 / 250 / 500 tasks; per band, the cheapest model (by posterior mean cost)
whose posterior mean success is within x = 0.03 of the band's best; modal choice and its share over streams; "truth" =
the same rule on the full matrix.
Non-stationarity (random order and by-repo order; V in {$20, $1, $0.2}):
  NEW-A  the model with the best cost per solved task over the full matrix (rule; = deepseek-v3.2-reasoner) is absent
         until task 250. NEW-B  the hindsight-best model at that lambda is absent until task 250.
         Adoption = tasks after 250 until the new model holds >= 50 % of the stream's last 20 picks (censored at 500).
  DEGRADE the hindsight-best model at that lambda keeps its cost but from task 250 its outcomes are those of the model
         whose overall solve rate is closest to its own minus 0.25. Drop = tasks after 250 until its share of the last
         20 picks is < 50 % (streams where it held >= 50 % at task 250).
  Forgetting variants: discount gamma = 0.99 (effective memory ~100 tasks) and a sliding window of 100 tasks; their
  price in the stationary case is reported as extra regret.
"""

from __future__ import annotations

import time

import numpy as np

from . import config as C
from .stage2 import ci, save
from .stage4_common import BAND_NAMES, N_STREAMS, ORDERS, boot_stat, load_arms, make_orders

VALUES = (np.inf, 20.0, 5.0, 2.0, 1.0, 0.5, 0.2)
QS = (0.90, 0.95)
T0 = 0.5
SIG_C = 0.8
N0_BAND = 4.0
N0_INF = 20.0
EPS = 0.1
DELTA = 0.05
MARGINS = (0.02, 0.05)
SMOOTH = 25
TIER_X = 0.03
T_NEW = 250


def lam_of(v):
    return 0.0 if np.isinf(v) else 1.0 / v


def vlabel(v):
    return "V=inf" if np.isinf(v) else f"V=${v:g}"


# ----------------------------------------------------------------------------------------------------- environment
class Env:
    """Holds the full matrix; returns only the chosen (arm, task) cell. Optional degradation of one arm from t0."""

    def __init__(self, R, Kc, orders, degrade=None):
        self._R, self._K, self._o = R, Kc, orders
        self._deg = degrade  # (arm, replacement_arm, t0)
        self.calls = 0

    def pull(self, t, arms):
        task = self._o[:, t]
        y = self._R[arms, task]
        if self._deg is not None and t >= self._deg[2]:
            y = np.where(arms == self._deg[0], self._R[self._deg[1], task], y)
        self.calls += 1
        return y.astype(float), self._K[arms, task]


# ----------------------------------------------------------------------------------------------------- learners
class Stats:
    """Per stream x arm counts; optional exponential discount or sliding window."""

    def __init__(self, ns, K, T, discount=None, window=None):
        self.n = np.zeros((ns, K))
        self.s = np.zeros((ns, K))
        self.c = np.zeros((ns, K))
        self.discount, self.window = discount, window
        if window:
            self.h = np.zeros((ns, T), int), np.zeros((ns, T)), np.zeros((ns, T))

    def add(self, t, a, y, c):
        i = np.arange(len(a))
        if self.discount:
            self.n *= self.discount
            self.s *= self.discount
            self.c *= self.discount
        self.n[i, a] += 1
        self.s[i, a] += y
        self.c[i, a] += c
        if self.window:
            ha, hy, hc = self.h
            ha[:, t], hy[:, t], hc[:, t] = a, y, c
            if t - self.window >= 0:
                u = t - self.window
                self.n[i, ha[:, u]] -= 1
                self.s[i, ha[:, u]] -= hy[:, u]
                self.c[i, ha[:, u]] -= hc[:, u]


class Policy:
    name = "policy"

    def __init__(self, A, ns, T, lam, rng, q=None):
        self.A, self.ns, self.T, self.lam, self.rng, self.q = A, ns, T, lam, rng, q
        self.K = len(A.names)

    def choose(self, t, avail):
        raise NotImplementedError

    def update(self, t, a, y, c):
        pass


class TS(Policy):
    def __init__(self, A, ns, T, lam, rng, q=None, prior="flat", discount=None, window=None):
        super().__init__(A, ns, T, lam, rng, q)
        self.prior = prior
        self.st = Stats(ns, self.K, T, discount, window)
        self.name = "ts_" + prior + (f"_disc{discount}" if discount else "") + (f"_win{window}" if window else "")
        self.onehot = np.eye(3)[A.band]  # (K, 3)

    def posterior(self):
        n, s, c = self.st.n, self.st.s, self.st.c
        price = self.A.price[None]
        if self.prior == "flat":
            a0, b0 = np.ones_like(n), np.ones_like(n)
            c0 = np.broadcast_to(price * T0, n.shape)
        elif self.prior == "informed":  # per-stream aggregate of an out-of-sample half (a "leaderboard")
            a0, b0 = N0_INF * self.inf_m + 0.5, N0_INF * (1 - self.inf_m) + 0.5
            c0 = self.inf_c
        else:
            Sb, Nb = s @ self.onehot, n @ self.onehot  # (ns, 3)
            Cb, Pb = c @ self.onehot, (n * price) @ self.onehot
            S_ex = Sb[:, self.A.band] - s
            N_ex = Nb[:, self.A.band] - n
            m = (S_ex + 1) / (N_ex + 2)
            a0, b0 = N0_BAND * m, N0_BAND * (1 - m)
            tau = (Cb[:, self.A.band] - c + T0) / (Pb[:, self.A.band] - n * price + 1.0)
            c0 = price * tau
        return a0 + s, b0 + (n - s), (c0 + c) / (1 + n), n

    def choose(self, t, avail):
        a, b, chat, n = self.posterior()
        p = self.rng.beta(np.maximum(a, 1e-6), np.maximum(b, 1e-6))
        cs = chat * np.exp(SIG_C * self.rng.standard_normal(chat.shape) / np.sqrt(1 + n))
        if self.q is None:
            sc = np.where(avail, p - self.lam * cs, -np.inf)
            return sc.argmax(1)
        pa = np.where(avail, p, -np.inf)
        ok = avail & (p >= self.q * pa.max(1, keepdims=True))
        return np.where(ok, cs, np.inf).argmin(1)

    def update(self, t, a, y, c):
        self.st.add(t, a, y, c)


class UCB(Policy):
    name = "ucb"

    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self.st = Stats(self.ns, self.K, self.T)

    def choose(self, t, avail):
        n, s, c = self.st.n, self.st.s, self.st.c
        lg = np.sqrt(2 * np.log(t + 2))
        p = (s + 1) / (n + 2) + lg / np.sqrt(np.maximum(n, 1e-9))
        chat = (self.A.price[None] * T0 + c) / (1 + n)
        cs = chat * np.exp(-SIG_C * lg / np.sqrt(1 + n))
        sc = np.where(n == 0, 1e9, p - self.lam * cs)
        sc = np.where(avail, sc + 1e-9 * self.rng.random(sc.shape), -np.inf)
        return sc.argmax(1)

    def update(self, t, a, y, c):
        self.st.add(t, a, y, c)


class SuccElim(Policy):
    name = "succ_elim"

    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self.st = Stats(self.ns, self.K, self.T)
        self.active = np.ones((self.ns, self.K), bool)
        self.rr = 1 + 2 * self.lam

    def choose(self, t, avail):
        act = self.active & avail
        act = np.where(act.any(1, keepdims=True), act, avail)
        sc = np.where(act, self.st.n + 1e-3 * self.rng.random(act.shape), np.inf)
        return sc.argmin(1)

    def update(self, t, a, y, c):
        self.st.add(t, a, y, c)
        n = self.st.n
        mu = (self.st.s - self.lam * self.st.c) / np.maximum(n, 1)
        w = self.rr * np.sqrt(np.log(4 * self.K * (t + 1) ** 2 / DELTA) / (2 * np.maximum(n, 1)))
        ready = (np.where(self.active, n, np.inf).min(1) >= 1)[:, None]
        best_lcb = np.where(self.active, mu - w, -np.inf).max(1, keepdims=True)
        drop = ready & self.active & (mu + w < best_lcb)
        self.active &= ~drop


class EpsGreedy(Policy):
    name = "eps_greedy"

    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self.st = Stats(self.ns, self.K, self.T)

    def choose(self, t, avail):
        n = self.st.n
        mu = (self.st.s - self.lam * self.st.c) / np.maximum(n, 1)
        sc = np.where(n == 0, 1e9, mu) + 1e-9 * self.rng.random(n.shape)
        g = np.where(avail, sc, -np.inf).argmax(1)
        r = np.where(avail, self.rng.random(n.shape), -1).argmax(1)
        return np.where(self.rng.random(self.ns) < EPS, r, g)

    def update(self, t, a, y, c):
        self.st.add(t, a, y, c)


class Uniform(Policy):
    name = "uniform"

    def choose(self, t, avail):
        return np.where(avail, self.rng.random((self.ns, self.K)), -1).argmax(1)


class Fixed(Policy):
    def __init__(self, A, ns, T, lam, rng, q=None, arm=0, name="fixed"):
        super().__init__(A, ns, T, lam, rng, q)
        self.arm, self.name = arm, name

    def choose(self, t, avail):
        return np.full(self.ns, self.arm)


def simulate(pol, env, T, avail_fn, snaps=()):
    ns = pol.ns
    arms = np.empty((ns, T), int)
    snap = {}
    for t in range(T):
        a = pol.choose(t, avail_fn(t))
        y, c = env.pull(t, a)
        pol.update(t, a, y, c)
        arms[:, t] = a
        if t + 1 in snaps and hasattr(pol, "st"):
            snap[t + 1] = (pol.st.n.copy(), pol.st.s.copy(), pol.st.c.copy())
    return arms, snap


# ----------------------------------------------------------------------------------------------------- baselines
def ladders(A):
    K = len(A.names)
    b = A.band
    idx = np.arange(K)
    lp = (idx[b == 0][A.price[b == 0].argmin()], idx[b == 1][A.price[b == 1].argmin()], idx[b == 2][A.price[b == 2].argmax()])
    lb = tuple(idx[b == k][A.headline[b == k].argmax()] for k in range(3))
    mean_cost = A.Kc.mean(1)  # = the published mean instance cost of the run
    cps = mean_cost / np.maximum(A.headline, 1e-9)
    lc = tuple(idx[b == k][cps[b == k].argmin()] for k in range(3))
    return {"list_price": lp, "leaderboard": lb, "leaderboard_cost_per_solved": lc}


# ----------------------------------------------------------------------------------------------------- metrics
def until_margin(inst, m):
    """inst: (ns, T) per-decision pseudo-regret. First t after which the stream-mean, smoothed, stays <= m."""
    def f(x):
        cs = np.concatenate([[0.0], np.cumsum(x.mean(0))])
        t = np.arange(1, len(cs))
        lo = np.maximum(t - SMOOTH, 0)
        g = (cs[t] - cs[lo]) / (t - lo)  # trailing mean over the last SMOOTH decisions
        bad = np.where(g > m)[0]
        return float(bad.max() + 1) if len(bad) else 0.0
    rng = np.random.default_rng(C.SEED + 401)
    vals = [f(inst[rng.integers(0, len(inst), len(inst))]) for _ in range(300)]
    pt = f(inst)
    return {"point": pt, "lo": float(np.percentile(vals, 2.5)), "hi": float(np.percentile(vals, 97.5)),
            "never_within_by_500": bool(pt >= inst.shape[1])}


def evaluate(A, orders, arms, lam, best):
    task = orders
    Rr, Kr = A.R[arms, task], A.Kc[arms, task]
    rew = Rr - lam * Kr
    rew_best = A.R[best, task] - lam * A.Kc[best, task]
    mu = (A.R - lam * A.Kc).mean(1)
    inst = mu[best] - mu[arms]
    cum = (rew_best - rew).cumsum(1)
    solved, cost = Rr.sum(1), Kr.sum(1)
    out = {"cum_regret_500": ci(cum[:, -1]), "cum_regret_100": ci(cum[:, 99]), "cum_regret_250": ci(cum[:, 249]),
           "mean_regret_per_task_last100": ci((rew_best - rew)[:, -100:].mean(1)),
           "solve_rate": ci(solved / A.R.shape[1]), "cost_per_task": ci(cost / A.R.shape[1]),
           "cost_per_solved": ci(cost / np.maximum(solved, 1)),
           "extra_cost_usd_vs_best_500": ci(cost - A.Kc[best].sum()),
           "extra_solves_vs_best_500": ci(solved - A.R[best].sum()),
           "distinct_models_tried": ci([len(np.unique(a)) for a in arms]),
           "share_on_best_last100": float((arms[:, -100:] == best).mean())}
    for m in MARGINS:
        out[f"tasks_until_pseudo_regret_le_{m}"] = until_margin(inst, m)
    return out, cum


def fixed_eval(A, arm, lam):
    return {"model": A.names[arm], "solve_rate": float(A.R[arm].mean()), "cost_per_task": float(A.Kc[arm].mean()),
            "cost_per_solved": float(A.Kc[arm].sum() / max(A.R[arm].sum(), 1)),
            "mean_reward": float((A.R[arm] - lam * A.Kc[arm]).mean())}


def tier_view(A, snap):
    out = {}
    for N, (n, s, c) in snap.items():
        p = (s + 1) / (n + 2)
        chat = (A.price[None] * T0 + c) / (1 + n)
        res = {}
        for b in range(3):
            idx = np.where(A.band == b)[0]
            pb = p[:, idx]
            ok = pb >= pb.max(1, keepdims=True) - TIER_X
            pick = idx[np.where(ok, chat[:, idx], np.inf).argmin(1)]
            u, cnt = np.unique(pick, return_counts=True)
            order = np.argsort(-cnt)
            res[BAND_NAMES[b]] = {"modal": A.names[u[order[0]]], "share": float(cnt[order[0]] / len(pick)),
                                  "top3": {A.names[u[k]]: float(cnt[k] / len(pick)) for k in order[:3]}}
        out[f"after_{N}"] = res
    truth = {}
    for b in range(3):
        idx = np.where(A.band == b)[0]
        p, c = A.R[idx].mean(1), A.Kc[idx].mean(1)
        ok = p >= p.max() - TIER_X
        truth[BAND_NAMES[b]] = A.names[idx[np.where(ok, c, np.inf).argmin()]]
    out["truth_full_matrix"] = truth
    return out


def share_track(arms, j, t0, win=20):
    """Per stream: tasks after t0 until share of arm j in the last `win` picks >= 0.5 (adopt)."""
    hit = (arms == j).astype(float)
    cs = np.cumsum(np.pad(hit, ((0, 0), (1, 0))), 1)
    roll = (cs[:, win:] - cs[:, :-win]) / win  # roll[:, k] = share in picks k..k+win-1 ; ends at t = k + win - 1
    ends = np.arange(win - 1, arms.shape[1])
    return roll, ends


def adoption(arms, j, t0):
    roll, ends = share_track(arms, j, t0)
    res = []
    for s in range(len(arms)):
        k = np.where((ends >= t0) & (roll[s] >= 0.5))[0]
        res.append(ends[k[0]] - t0 + 1 if len(k) else np.nan)
    res = np.array(res, float)
    fin = res[~np.isnan(res)]
    return {"median_tasks": float(np.median(fin)) if len(fin) else None,
            "q10_q90": [float(np.percentile(fin, 10)), float(np.percentile(fin, 90))] if len(fin) else None,
            "share_streams_adopted_by_500": float((~np.isnan(res)).mean()),
            "share_of_picks_tasks_400_500": float((arms[:, 400:] == j).mean())}


def dropping(arms, j, t0):
    roll, ends = share_track(arms, j, t0)
    at = roll[:, np.where(ends == t0 - 1)[0][0]]
    use = at >= 0.5
    res = []
    for s in np.where(use)[0]:
        k = np.where((ends >= t0) & (roll[s] < 0.5))[0]
        res.append(ends[k[0]] - t0 + 1 if len(k) else np.nan)
    res = np.array(res, float)
    fin = res[~np.isnan(res)]
    return {"streams_using_it_at_250": int(use.sum()),
            "median_tasks_to_drop": float(np.median(fin)) if len(fin) else None,
            "q10_q90": [float(np.percentile(fin, 10)), float(np.percentile(fin, 90))] if len(fin) else None,
            "share_dropped_by_500": float((~np.isnan(res)).mean()) if len(res) else None,
            "share_of_picks_tasks_400_500": float((arms[:, 400:] == j).mean())}


# ----------------------------------------------------------------------------------------------------- main
def factories(stationary=True):
    f = {"ts_flat": lambda *a, **k: TS(*a, **k, prior="flat"), "ts_band": lambda *a, **k: TS(*a, **k, prior="band"),
         "ucb": UCB, "succ_elim": SuccElim, "eps_greedy": EpsGreedy, "uniform": Uniform}
    return f


def main():
    t0 = time.time()
    A = load_arms()
    K, T = A.R.shape
    ns = N_STREAMS
    L = ladders(A)
    all_av = np.ones((ns, K), bool)
    res = {"method": __doc__, "arms": [{"model": A.names[j], "submission": A.subs[j], "band": BAND_NAMES[A.band[j]],
                                        "price_blended_per_m": float(A.price[j]), "headline": float(A.headline[j]),
                                        "solve_rate": float(A.R[j].mean()), "cost_per_task": float(A.Kc[j].mean())} for j in range(K)],
           "ladders": {k: [A.names[j] for j in v] for k, v in L.items()},
           "lambda_grid": {vlabel(v): lam_of(v) for v in VALUES}}
    orders = {o: make_orders(A.tasks, o, ns, C.SEED + 400 + i) for i, o in enumerate(ORDERS)}
    curves = {}
    obj = {}
    for v in VALUES:
        lam = lam_of(v)
        mu = (A.R - lam * A.Kc).mean(1)
        best = int(mu.argmax())
        e = {"best_fixed_in_hindsight": fixed_eval(A, best, lam),
             "lambda": lam}
        for lname, rungs in L.items():
            rr = [fixed_eval(A, j, lam) | {"rung": BAND_NAMES[i]} for i, j in enumerate(rungs)]
            e[f"{lname}_ladder_best_rung"] = max(rr, key=lambda r: r["mean_reward"])
            e[f"{lname}_ladder_rungs"] = rr
        for oname, od in orders.items():
            eo = {}
            for k, fac in factories().items():
                pol = fac(A, ns, T, lam, np.random.default_rng(C.SEED + 410))
                snaps = (100, 250, 500) if (k == "ts_flat" and oname == "random") else ()
                arms, snap = simulate(pol, Env(A.R, A.Kc, od), T, lambda t: all_av, snaps)
                eo[k], cum = evaluate(A, od, arms, lam, best)
                if snap:
                    eo[k]["tier_view"] = tier_view(A, snap)
                if oname == "random":
                    curves[(vlabel(v), k)] = (cum.mean(0), np.percentile(cum, 2.5, 0), np.percentile(cum, 97.5, 0))
            e[oname] = eo
        obj[vlabel(v)] = e
        print(vlabel(v), round(time.time() - t0), "s", flush=True)
        res["objective_i"] = obj
        save("stage4_ladder.json", res)
    # ---- objective (ii): constrained
    cons = {}
    best_rate = A.R.mean(1).max()
    for q in QS:
        target = q * best_rate
        rates, costs = A.R.mean(1), A.Kc.mean(1)
        ok = np.where(rates >= target)[0]
        hb = int(ok[costs[ok].argmin()])
        e = {"best_model_rate": float(best_rate), "target": float(target), "hindsight_cheapest_meeting": fixed_eval(A, hb, 0)}
        hl = A.headline
        for lname, rungs in L.items():
            meet = [j for j in rungs if hl[j] >= q * hl.max()]
            j = min(meet, key=lambda j: A.price[j]) if meet else rungs[2]
            e[f"{lname}_ladder"] = fixed_eval(A, j, 0) | {"meets_target": bool(rates[j] >= target),
                                                          "rule": "cheapest rung (list price) whose headline >= q x best headline, else the high rung"}
        for oname, od in orders.items():
            eo = {}
            for k in ("ts_flat", "ts_band"):
                pol = TS(A, ns, T, 0.0, np.random.default_rng(C.SEED + 420), q=q, prior=k[3:])
                arms, _ = simulate(pol, Env(A.R, A.Kc, od), T, lambda t: all_av)
                Rr, Kr = A.R[arms, od], A.Kc[arms, od]
                ratio = Rr.mean(1) / A.R[A.R.mean(1).argmax(), :].mean()
                eo[k] = {"quality_ratio": ci(ratio), "share_streams_meeting": float((ratio >= q).mean()),
                         "cost_per_task": ci(Kr.mean(1)), "cost_rel_hindsight_cheapest_meeting": ci(Kr.sum(1) / A.Kc[hb].sum()),
                         "share_on_hindsight_choice_last100": float((arms[:, -100:] == hb).mean())}
            e[oname] = eo
        cons[f"q={q}"] = e
    res["objective_ii"] = cons
    save("stage4_ladder.json", res)
    print("constrained", round(time.time() - t0), "s", flush=True)
    # ---- non-stationarity
    ns_res = {}
    cost_per_solved = A.Kc.mean(1) / np.maximum(A.R.mean(1), 1e-9)
    newA = int(cost_per_solved.argmin())
    ns_res["new_A_model_rule_best_cost_per_solved"] = A.names[newA]
    for v in (20.0, 1.0, 0.2):
        lam = lam_of(v)
        mu = (A.R - lam * A.Kc).mean(1)
        best = int(mu.argmax())
        rates = A.R.mean(1)
        repl = int(np.argmin(np.where(np.arange(K) == best, np.inf, np.abs(rates - (rates[best] - 0.25)))))
        e = {"hindsight_best": A.names[best], "degrade_replacement": A.names[repl],
             "newA_is_hindsight_best_here": bool(newA == best)}
        for oname in ("random", "by_repo"):
            od = orders[oname]
            eo = {}
            for scen, j in (("new_A", newA), ("new_B", best)):
                def av(t, j=j):
                    m = np.ones((ns, K), bool)
                    if t < T_NEW:
                        m[:, j] = False
                    return m
                for k in ("ts_flat", "ts_band", "ucb"):
                    pol = factories()[k](A, ns, T, lam, np.random.default_rng(C.SEED + 430))
                    arms, _ = simulate(pol, Env(A.R, A.Kc, od), T, av)
                    eo[f"{scen}/{k}"] = adoption(arms, j, T_NEW)
                    if oname == "random" and v == 1.0 and scen == "new_B":
                        curves[("adopt", k)] = (arms == j).mean(0)
            for k, kw in (("ts_flat", {}), ("ts_flat_disc0.99", {"discount": 0.99}), ("ts_flat_win100", {"window": 100})):
                pol = TS(A, ns, T, lam, np.random.default_rng(C.SEED + 440), prior="flat", **kw)
                arms, _ = simulate(pol, Env(A.R, A.Kc, od, degrade=(best, repl, T_NEW)), T, lambda t: all_av)
                eo[f"degrade/{k}"] = dropping(arms, best, T_NEW)
                if oname == "random" and v == 1.0:
                    curves[("degrade", k)] = (arms == best).mean(0)
                # stationary price of forgetting
                pol = TS(A, ns, T, lam, np.random.default_rng(C.SEED + 440), prior="flat", **kw)
                arms, _ = simulate(pol, Env(A.R, A.Kc, od), T, lambda t: all_av)
                ev, _ = evaluate(A, od, arms, lam, best)
                eo[f"stationary/{k}"] = {"cum_regret_500": ev["cum_regret_500"], "solve_rate": ev["solve_rate"],
                                         "cost_per_solved": ev["cost_per_solved"]}
            e[oname] = eo
        ns_res[vlabel(v)] = e
        print("nonstat", vlabel(v), round(time.time() - t0), "s", flush=True)
    res["non_stationary"] = ns_res
    res["informed_split"] = split_experiment(A)
    print("split", round(time.time() - t0), "s", flush=True)
    res["runtime_s"] = round(time.time() - t0)
    save("stage4_ladder.json", res)
    figures(curves)
    print("done", res["runtime_s"], "s")


def split_experiment(A):
    K, n = A.R.shape
    ns = N_STREAMS
    rng = np.random.default_rng(C.SEED + 450)
    inA = np.array([rng.permutation(n) < n // 2 for _ in range(ns)])
    orders = np.array([rng.permutation(np.where(~m)[0]) for m in inA])  # (ns, 250) half B
    hA = np.array([A.R[:, m].mean(1) for m in inA])
    cA = np.array([A.Kc[:, m].mean(1) for m in inA])
    T = orders.shape[1]
    av = np.ones((ns, K), bool)
    out = {}
    for v in (np.inf, 20.0, 1.0, 0.2):
        lam = lam_of(v)
        Rb = A.R[:, orders]  # (K, ns, T)
        Kb = A.Kc[:, orders]
        muB = (Rb - lam * Kb).mean(2).T  # (ns, K)
        best = muB.argmax(1)
        lead = (hA - lam * cA).argmax(1)  # half-A best at lambda
        band_best = [np.where(A.band == b)[0][hA[:, A.band == b].argmax(1)] for b in range(3)]
        si = np.arange(ns)

        def score(arms):
            rew = A.R[arms, orders] - lam * A.Kc[arms, orders]
            rb = A.R[best[:, None], orders] - lam * A.Kc[best[:, None], orders]
            solved, cost = A.R[arms, orders].sum(1), A.Kc[arms, orders].sum(1)
            return {"cum_regret_vs_B_hindsight_best": ci((rb - rew).sum(1)), "solve_rate": ci(solved / T),
                    "cost_per_solved": ci(cost / np.maximum(solved, 1)), "mean_reward": ci(rew.mean(1))}

        e = {"share_streams_halfA_best_equals_halfB_best": float((lead == best).mean()),
             "leaderboard_halfA_best_model": score(np.repeat(lead[:, None], T, 1))}
        rungs = np.stack(band_best, 1)  # (ns, 3)
        rr = [(A.R[rungs[si, b][:, None], orders] - lam * A.Kc[rungs[si, b][:, None], orders]).mean(1) for b in range(3)]
        hA_rew = np.stack([hA[si, rungs[:, b]] - lam * cA[si, rungs[:, b]] for b in range(3)], 1)
        pick = rungs[si, hA_rew.argmax(1)]  # rung chosen on half A
        e["leaderboard_ladder_halfA_rung"] = score(np.repeat(pick[:, None], T, 1))
        for k in ("ts_flat", "ts_informed"):
            pol = TS(A, ns, T, lam, np.random.default_rng(C.SEED + 451), prior=k[3:])
            pol.inf_m, pol.inf_c = hA, cA
            arms, _ = simulate(pol, Env(A.R, A.Kc, orders), T, lambda t: av)
            e[k] = score(arms)
            e[k]["share_on_B_best_last50"] = float((arms[:, -50:] == best[:, None]).mean())
        out[vlabel(v)] = e
    return out


def figures(curves):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axs = plt.subplots(1, 3, figsize=(15, 4.6))
    pols = ("ts_flat", "ts_band", "ucb", "succ_elim", "eps_greedy", "uniform")
    for ax, v in zip(axs, ("V=$20", "V=$1", "V=$0.2")):
        for k in pols:
            if (v, k) not in curves:
                continue
            m, lo, hi = curves[(v, k)]
            x = np.arange(1, len(m) + 1)
            ax.plot(x, m, label=k, lw=1.4)
            ax.fill_between(x, lo, hi, alpha=0.12)
        ax.set_title(f"L1 cumulative regret vs best fixed model, {v} per solved (random order)", fontsize=8.5)
        ax.set_xlabel("tasks in the stream")
        ax.set_ylabel("cumulative regret (solved - lambda cost)")
        ax.grid(color="#d0d7de", lw=0.6)
        ax.axhline(0, color="k", lw=0.5)
    axs[0].legend(frameon=False, fontsize=7)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage4_regret.png", dpi=130)
    plt.close(fig)
    fig, axs = plt.subplots(1, 2, figsize=(12, 4.4))
    for k in ("ts_flat", "ts_band", "ucb"):
        if ("adopt", k) in curves:
            axs[0].plot(curves[("adopt", k)], label=k)
    axs[0].axvline(T_NEW, color="k", lw=0.6, ls="--")
    axs[0].set_title("New model appears at task 250 (NEW-B, V=$1): share of streams picking it", fontsize=9)
    for k in ("ts_flat", "ts_flat_disc0.99", "ts_flat_win100"):
        if ("degrade", k) in curves:
            axs[1].plot(curves[("degrade", k)], label=k)
    axs[1].axvline(T_NEW, color="k", lw=0.6, ls="--")
    axs[1].set_title("Best model degrades at task 250 (V=$1): share of streams still picking it", fontsize=9)
    for ax in axs:
        ax.set_xlabel("tasks in the stream")
        ax.grid(color="#d0d7de", lw=0.6)
        ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage4_adoption.png", dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    main()
