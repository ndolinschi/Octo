"""Stage 4, L3: a quality controller that holds a declared target with a stated risk (criterion 4').

Two settings, both split per stream (200 streams, seed fixed): a random half A of the 500 tasks is OFFLINE data with
full information (every arm's outcome and cost on every A task); the other half B (250 tasks) is the stream, with bandit
feedback (only the chosen arm's outcome is observed). Orders of B: random, and by repository (repositories in a random
order, created_at inside).
  "tiers"  stage 2's setting: 3 arms = scheme-A tiers; outcome of a pull = a 0/1 draw from the tier's soft label on the
           task (pre-drawn per stream, the Env hands out only the chosen cell); quality is scored in expectation (the
           soft label of the chosen tier), cost = the tier's mean cost on the task. Reference = always-high.
  "models" L1's setting: 33 concrete models (stage4_common.load_arms); outcome = the run's resolved; quality scored on
           resolved. Reference = the model with the best solve rate on half A ("always the best model").
Target (declared): quality on B >= tau x the reference's quality on B, tau = 0.95 (tiers; stage 2's target) and
tau = 0.95 / 0.90 (models).
Policies:
  always_ref         the reference arm on every task.
  offline_mix(d)     the cheapest randomised mixture of arms (two arms on the lower hull) whose quality on half A is
                     >= (tau + d) x the reference's on A, d in {-0.02, 0, 0.01, 0.02, 0.03, 0.05, 0.08}; fixed for the
                     whole stream (the honest offline baseline, tuned only on the held-out half A).
  lcb(conf)          the conservative controller. Before every task it draws M = 100 joint samples of the arms'
                     success rates: a bootstrap of the half-A tasks (keeps the correlation between arms), combined with
                     a Beta posterior of the arm's own pulls on B. For a ladder of candidate mixtures (cheapest mixture
                     on the posterior means at quality ratio rho, rho = 0.80 ... 1.00 step 0.0025) it computes the
                     stream-level ratio  (sum_j n_j p_j + (T - t) sum_j w_j p_j) / (T p_ref), i.e. the picks already
                     made plus the remaining tasks at the candidate mixture, and plays the cheapest candidate whose
                     (1 - conf) quantile of that ratio is >= tau (else the reference arm). conf in {0.5, 0.8, 0.9, 0.95,
                     0.99}. It sees nothing about a task before choosing for it, and only the chosen arm's outcome after.
Metrics (per stream, then over streams): achieved ratio (quality on B / reference's on B), cost saved = 1 - cost /
reference's cost, share of streams violating the target at the end, share violating at any point after a burn-in of 50
tasks (running ratio over the tasks so far). Trade-off curve: violation rate vs cost saved for both families; the
offline curve is interpolated at each controller's violation rate for a like-for-like comparison.
"""

from __future__ import annotations

import time

import numpy as np

from . import config as C
from .ceiling import costs, shares
from .stage2 import ci, load_matrix, save
from .stage4_common import N_STREAMS, load_arms, make_orders

DELTAS = (-0.02, 0.0, 0.01, 0.02, 0.03, 0.05, 0.08)
CONFS = (0.5, 0.8, 0.9, 0.95, 0.99)
M_SAMP = 100
RHOS = np.round(np.arange(0.80, 1.0001, 0.0025), 4)
BURN = 50


def cheapest_mix(p, c, target):
    """p, c: (..., K); target: (...). Cheapest mixture of at most two arms with mean quality >= target.
    Returns weights (..., K). If no arm reaches the target, all weight on the best arm."""
    K = p.shape[-1]
    i, j = np.triu_indices(K, 0)
    pi, pj, ci_, cj = p[..., i], p[..., j], c[..., i], c[..., j]
    tg = target[..., None]
    lo_p, hi_p = np.minimum(pi, pj), np.maximum(pi, pj)
    lo_c = np.where(pi <= pj, ci_, cj)
    hi_c = np.where(pi <= pj, cj, ci_)
    w = np.clip((tg - lo_p) / np.maximum(hi_p - lo_p, 1e-12), 0, 1)
    w = np.where(lo_p >= tg, 0.0, w)
    feas = hi_p >= tg - 1e-12
    cost = np.where(feas, (1 - w) * lo_c + w * hi_c, np.inf)
    k = cost.argmin(-1)
    W = np.zeros(p.shape)
    ii = i[k]
    jj = j[k]
    ww = np.take_along_axis(w, k[..., None], -1)[..., 0]
    pli = np.take_along_axis(pi, k[..., None], -1)[..., 0] <= np.take_along_axis(pj, k[..., None], -1)[..., 0]
    lo_idx, hi_idx = np.where(pli, ii, jj), np.where(pli, jj, ii)
    any_feas = np.isfinite(np.take_along_axis(cost, k[..., None], -1)[..., 0])
    best = p.argmax(-1)
    lo_idx, hi_idx = np.where(any_feas, lo_idx, best), np.where(any_feas, hi_idx, best)
    ww = np.where(any_feas, ww, 1.0)
    np.put_along_axis(W, lo_idx[..., None], (1 - ww)[..., None], -1)
    Wh = np.zeros(p.shape)
    np.put_along_axis(Wh, hi_idx[..., None], ww[..., None], -1)
    return W + Wh


class Env:
    """Hands out only the chosen arm's outcome on the current task."""

    def __init__(self, Y, Kc, orders):
        self._Y, self._K, self._o = Y, Kc, orders  # Y: (ns, K, n_task) or (K, n_task)
        self.reads = []

    def pull(self, t, a):
        task = self._o[:, t]
        s = np.arange(len(a))
        y = self._Y[s, a, task] if self._Y.ndim == 3 else self._Y[a, task]
        self.reads.append(t)
        return y.astype(float), self._K[a, task]


class LCBController:
    def __init__(self, PA_boot, cA, ref, T, tau, conf, rng):
        # PA_boot: (ns, M, K) bootstrap means of half A; cA: (ns, K) mean cost on A; ref: (ns,) reference arm
        self.PA, self.cA, self.ref, self.T, self.tau, self.conf, self.rng = PA_boot, cA, ref, T, tau, conf, rng
        ns, M, K = PA_boot.shape
        self.nA = None
        self.n = np.zeros((ns, K))
        self.s = np.zeros((ns, K))
        self.csum = np.zeros((ns, K))
        self.mixes = None

    def setup(self, nA):
        self.nA = nA
        pbar = self.PA.mean(1)
        ns, K = pbar.shape
        tg = RHOS[None, :] * pbar[np.arange(ns), self.ref][:, None]
        self.W = cheapest_mix(np.repeat(pbar[:, None], len(RHOS), 1), np.repeat(self.cA[:, None], len(RHOS), 1), tg)

    def choose(self, t):
        ns, M, K = self.PA.shape
        si = np.arange(ns)
        # joint samples: half-A bootstrap combined with a Beta draw from the arm's own B pulls
        b = self.rng.beta(self.s[:, None] + 0.5, self.n[:, None] - self.s[:, None] + 0.5, size=(ns, M, K))
        P = (self.nA * self.PA + self.n[:, None] * b) / (self.nA + self.n[:, None])
        pref = P[si, :, self.ref]  # (ns, M)
        past = (self.n[:, None] * P).sum(2)  # (ns, M)
        fut = np.einsum("smk,srk->smr", P, self.W)  # (ns, M, R)
        ratio = (past[..., None] + (self.T - t) * fut) / (self.T * pref[..., None])
        qlo = np.quantile(ratio, 1 - self.conf, axis=1)  # (ns, R)
        ok = qlo >= self.tau
        r = np.where(ok.any(1), ok.argmax(1), -1)
        w = np.where((r >= 0)[:, None], self.W[si, np.maximum(r, 0)], np.eye(K)[self.ref])
        u = self.rng.random(ns)
        return (w.cumsum(1) < u[:, None]).sum(1).clip(0, K - 1)

    def update(self, t, a, y, c):
        si = np.arange(len(a))
        self.n[si, a] += 1
        self.s[si, a] += y
        self.csum[si, a] += c


def run_setting(name, Q, Kc, Ydraw, tasks, taus, seed):
    """Q: (K, n) quality used for scoring (soft label or resolved); Kc: (K, n) cost; Ydraw: (ns, K, n) or (K, n) outcomes
    the controller observes. Returns per-tau results and curve points."""
    K, n = Q.shape
    ns = N_STREAMS
    rng = np.random.default_rng(seed)
    inA = np.array([rng.permutation(n) < n // 2 for _ in range(ns)])
    res = {}
    curves = {}
    for oname in ("random", "by_repo"):
        base = make_orders(tasks, oname, ns, seed + 1)
        orders = np.array([o[~inA[s][o]] for s, o in enumerate(base)])  # half B in the order's sequence
        T = orders.shape[1]
        pA = np.array([Q[:, m].mean(1) for m in inA])  # (ns, K)
        cA = np.array([Kc[:, m].mean(1) for m in inA])
        ref = pA.argmax(1) if name == "models" else np.full(ns, K - 1)
        si = np.arange(ns)
        brng = np.random.default_rng(seed + 2)
        idxA = [np.where(m)[0] for m in inA]
        PA_boot = np.array([Q[:, idxA[s][brng.integers(0, len(idxA[s]), (M_SAMP, len(idxA[s])))]].mean(2).T for s in range(ns)])
        qref = Q[ref[:, None], orders]  # (ns, T)
        cref = Kc[ref[:, None], orders]

        def score(arms):
            q = Q[arms, orders]
            c = Kc[arms, orders]
            ratio_end = q.sum(1) / qref.sum(1)
            run = q.cumsum(1) / np.maximum(qref.cumsum(1), 1e-9)
            return {"ratio": ratio_end, "saved": 1 - c.sum(1) / cref.sum(1), "run_min_after_burn": run[:, BURN:].min(1)}

        def summarise(sc, tau):
            return {"quality_ratio": ci(sc["ratio"]), "cost_saved": ci(sc["saved"]),
                    "violation_end": float((sc["ratio"] < tau).mean()),
                    "violation_any_after_burn_in": float((sc["run_min_after_burn"] < tau).mean())}

        out = {"always_ref": summarise(score(np.repeat(ref[:, None], T, 1)), 1.0)}
        for tau in taus:
            et = {}
            off_pts, ctl_pts = [], []
            for d in DELTAS:
                W = cheapest_mix(pA, cA, (tau + d) * pA[si, ref])
                u = np.random.default_rng(seed + 3).random((ns, T))
                arms = (W.cumsum(1)[:, None, :] < u[..., None]).sum(2).clip(0, K - 1)
                sc = score(arms)
                et[f"offline_mix_d={d}"] = summarise(sc, tau) | {"mixture": {str(k): float(W[:, k].mean()) for k in range(K) if W[:, k].mean() > 0.01}}
                off_pts.append((et[f"offline_mix_d={d}"]["violation_end"], float(sc["saved"].mean()),
                                et[f"offline_mix_d={d}"]["violation_any_after_burn_in"], d))
            for conf in CONFS:
                t0 = time.time()
                ctl = LCBController(PA_boot, cA, ref, T, tau, conf, np.random.default_rng(seed + 4))
                ctl.setup(n // 2)
                env = Env(Ydraw, Kc, orders)
                arms = np.empty((ns, T), int)
                for t in range(T):
                    a = ctl.choose(t)
                    y, c = env.pull(t, a)
                    ctl.update(t, a, y, c)
                    arms[:, t] = a
                sc = score(arms)
                et[f"lcb_conf={conf}"] = summarise(sc, tau) | {"arm_share": {str(k): float((arms == k).mean()) for k in range(K) if (arms == k).mean() > 0.01},
                                                                "runtime_s": round(time.time() - t0, 1)}
                ctl_pts.append((et[f"lcb_conf={conf}"]["violation_end"], float(sc["saved"].mean()),
                                et[f"lcb_conf={conf}"]["violation_any_after_burn_in"], conf))
            # like-for-like: offline curve interpolated at the controller's violation rate (end)
            ov = sorted(off_pts)
            xs = np.array([p[0] for p in ov])
            ys = np.array([p[1] for p in ov])
            env_y = np.maximum.accumulate(ys)  # best offline saving achievable at <= that violation rate
            cmp = {}
            for v, s_, _, conf in ctl_pts:
                k = np.where(xs <= v + 1e-12)[0]
                off_at = float(env_y[k[-1]]) if len(k) else None
                cmp[f"lcb_conf={conf}"] = {"violation_end": v, "controller_saved": s_, "offline_best_saved_at_same_or_lower_violation": off_at,
                                           "controller_minus_offline": None if off_at is None else s_ - off_at}
            et["like_for_like"] = cmp
            out[f"tau={tau}"] = et
            curves[(name, oname, tau)] = (off_pts, ctl_pts)
        res[oname] = out
        print(name, oname, flush=True)
    return res, curves


def main():
    t0 = time.time()
    res = {"method": __doc__}
    allc = {}
    # tiers (stage 2)
    M = load_matrix()
    tier = M.tier_idx("A_model_terciles")
    rows = np.arange(len(tier))
    S, Kt = shares(M.R, rows, tier), costs(M.cost, rows, tier)  # (n, 3)
    ns = N_STREAMS
    ydraw = np.random.default_rng(C.SEED + 500)
    Y = (ydraw.random((ns, 3, S.shape[0])) < S.T[None]).astype(float)
    r, cv = run_setting("tiers", S.T, Kt.T, Y, M.tasks, (0.95,), C.SEED + 510)
    res["tiers"] = r
    allc.update(cv)
    save("stage4_controller.json", res)
    print("tiers", round(time.time() - t0), "s", flush=True)
    A = load_arms()
    r, cv = run_setting("models", A.R, A.Kc, A.R, A.tasks, (0.95, 0.90), C.SEED + 520)
    res["models"] = r
    res["models_arm_names"] = A.names
    allc.update(cv)
    res["runtime_s"] = round(time.time() - t0)
    res["like_for_like_interpolated"] = interpolate(res)
    save("stage4_controller.json", res)
    figure(allc)
    print("done", res["runtime_s"], "s")


def interpolate(res):
    """Offline curve made continuous: randomising between two margins per stream attains every convex combination of
    their (violation, saving) points, so the honest offline frontier is the upper concave envelope of its points.
    Returned: controller saving minus that envelope at the controller's own end-of-stream violation rate."""
    out = {}
    for setting in ("tiers", "models"):
        for oname in ("random", "by_repo"):
            for tk, et in res[setting][oname].items():
                if not tk.startswith("tau"):
                    continue
                pts = sorted((v["violation_end"], v["cost_saved"]["mean"]) for k, v in et.items() if k.startswith("offline"))
                hull = []
                for p in pts:  # upper concave envelope, x ascending
                    while len(hull) >= 2 and (hull[-1][1] - hull[-2][1]) * (p[0] - hull[-2][0]) <= (p[1] - hull[-2][1]) * (hull[-1][0] - hull[-2][0]):
                        hull.pop()
                    hull.append(p)
                hx, hy = np.array([h[0] for h in hull]), np.maximum.accumulate(np.array([h[1] for h in hull]))
                e = {}
                for k, v in et.items():
                    if k.startswith("lcb"):
                        x = v["violation_end"]
                        off = float(np.interp(x, hx, hy)) if x >= hx[0] else None
                        e[k] = {"violation_end": x, "controller_saved": v["cost_saved"]["mean"], "offline_envelope_saved": off,
                                "controller_minus_offline": None if off is None else v["cost_saved"]["mean"] - off}
                out[f"{setting}/{oname}/{tk}"] = e
    return out


def post():
    import json

    res = json.loads((C.RESULTS / "stage4_controller.json").read_text())
    res["like_for_like_interpolated"] = interpolate(res)
    save("stage4_controller.json", res)
    return res["like_for_like_interpolated"]


def figure(curves):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    keys = [k for k in curves if k[1] == "random"]
    fig, axs = plt.subplots(1, len(keys), figsize=(5 * len(keys), 4.4))
    for ax, k in zip(np.atleast_1d(axs), keys):
        off, ctl = curves[k]
        off = sorted(off)
        ax.plot([p[0] for p in off], [p[1] for p in off], "o-", label="offline mixture (half A), margin d")
        for p in off:
            ax.annotate(f"{p[3]:+g}", (p[0], p[1]), fontsize=6)
        ax.plot([p[0] for p in ctl], [p[1] for p in ctl], "s-", label="LCB controller, conf")
        for p in ctl:
            ax.annotate(f"{p[3]:g}", (p[0], p[1]), fontsize=6)
        ax.set_title(f"L3 {k[0]}, tau = {k[2]}, random order", fontsize=9)
        ax.set_xlabel("share of streams violating the target at the end")
        ax.set_ylabel("cost saved vs the reference (mean)")
        ax.grid(color="#d0d7de", lw=0.6)
        ax.legend(frameon=False, fontsize=7)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage4_controller.png", dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    import sys

    post() if "--post" in sys.argv else main()
