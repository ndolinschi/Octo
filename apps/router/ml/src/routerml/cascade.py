"""Stage 2, part B (matrix level): post-hoc failure detection of a cheap run and the cascade it enables.

Per-instance run features that exist in SWE-bench/experiments for the core (per_instance_details.json holds
exactly three fields: api_calls, cost, resolved): log api_calls, log cost, log cost per call, and a
limit flag (api_calls >= 250 or cost >= $2.95: mini-SWE-agent's default step limit 250 and cost limit $3).
`resolved` is the label, never a feature. These features exist only after the cheap run has ended.

Detector: logistic regression, leave-one-repository-out. Per model (each cheap submission alone) and pooled
(all cheap submissions of the tier; features z-scored per submission with means/SDs of the training repos only).
Baseline: the per-model prior (AUROC 0.5, Brier skill 0); the unfitted score "more API calls = more likely failed".

Cascade on the matrix: run a cheap-tier submission l to the end; if the detector says "failed" (pooled OOF
probability > theta), run the dearer tier. Escalated outcome = the dearer tier's soft label on that task (the
expectation over the dearer tier's submissions, i.e. averaged over all (l, h) pairs); cost = c_l + esc * K_h.
Averaged over the cheap submissions. Compared with: fixed tiers and their mixture (stage 1 baseline), random
escalation at the same rate, the perfect detector (escalates iff l did not resolve), and part A's honest oracle.
"""

from __future__ import annotations

import time

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from . import config as C
from .ceiling import costs, shares
from .evaluate import curve_metrics, fixed_points, upper_hull
from .stage2 import SCHEMES, ci, load_matrix, save

STEP_LIMIT, COST_LIMIT = 250, 2.95
CASCADES = {"low_to_high": (0, 2), "low_to_mid": (0, 1), "mid_to_high": (1, 2)}
N_BOOT = 1000
FEATURES = ("log_calls", "log_cost", "log_cost_per_call", "limit_hit")


def run_features(calls: np.ndarray, cost: np.ndarray) -> np.ndarray:
    """(n_task, 4) post-hoc features of one submission's runs. Uses nothing but api_calls and cost."""
    lc = np.log1p(calls)
    lk = np.log(cost + 1e-4)
    return np.column_stack([lc, lk, lk - lc, ((calls >= STEP_LIMIT) | (cost >= COST_LIMIT)).astype(float)])


def usable(M, rows):
    return [i for i in rows if not np.isnan(M.calls[i]).any() and not np.isnan(M.cost[i]).any()]


def loro_scores(M, rows, repos):
    """Out-of-fold P(fail) per (submission, task), leave-one-repository-out. Four scorers:
    per_model_lr   - one LR per cheap submission;
    pooled_lr      - shared slopes on per-submission z-scores + a per-submission intercept;
    features_only  - shared slopes on per-submission z-scores, no intercept (ranks runs within a model only);
    prior_only     - the submission's training-repository failure rate (a model-level decision, no run features).
    The intercept is a model-level signal: with it, a global threshold escalates weak cheap models wholesale."""
    n = M.R.shape[1]
    out = {k: np.full((len(rows), n), np.nan) for k in ("per_model_lr", "pooled_lr", "features_only", "prior_only")}
    X = [run_features(M.calls[i], M.cost[i]) for i in rows]
    Y = [1 - M.R[i] for i in rows]  # 1 = failed
    oh = np.eye(len(rows))
    for r in np.unique(repos):
        te, tr = repos == r, repos != r
        Xs, ys, Xt = [], [], []
        for j in range(len(rows)):
            mu, sd = X[j][tr].mean(0), X[j][tr].std(0)
            sd = np.where(sd < 1e-9, 1.0, sd)
            Ztr, Zte = (X[j][tr] - mu) / sd, (X[j][te] - mu) / sd
            out["prior_only"][j, te] = Y[j][tr].mean()
            if 0 < Y[j][tr].sum() < tr.sum():
                lr = LogisticRegression(C=1.0, max_iter=1000).fit(Ztr, Y[j][tr])
                out["per_model_lr"][j, te] = lr.predict_proba(Zte)[:, 1]
            else:
                out["per_model_lr"][j, te] = Y[j][tr].mean()
            Xs.append(Ztr)
            ys.append(Y[j][tr])
            Xt.append(Zte)
        yy = np.concatenate(ys)
        Xp = np.vstack([np.hstack([Xs[j], np.repeat(oh[j:j + 1], len(Xs[j]), 0)]) for j in range(len(rows))])
        lr = LogisticRegression(C=1.0, max_iter=2000).fit(Xp, yy)
        lf = LogisticRegression(C=1.0, max_iter=2000).fit(np.vstack(Xs), yy)
        for j in range(len(rows)):
            out["pooled_lr"][j, te] = lr.predict_proba(np.hstack([Xt[j], np.repeat(oh[j:j + 1], len(Xt[j]), 0)]))[:, 1]
            out["features_only"][j, te] = lf.predict_proba(Xt[j])[:, 1]
    return out


def auroc_block(P, Y, repos, rng, n_boot=N_BOOT):
    """Pooled AUROC over (submission, task) rows with a repository-cluster bootstrap interval."""
    ur = np.unique(repos)
    members = {r: np.where(repos == r)[0] for r in ur}
    def within(Yc, Pc):
        return float(np.mean([roc_auc_score(Yc[j], Pc[j]) for j in range(len(Yc)) if 0 < Yc[j].sum() < Yc.shape[1]]))

    point = roc_auc_score(Y.ravel(), P.ravel())
    w = within(Y, P)
    bs, bw = [], []
    for _ in range(n_boot):
        cols = np.concatenate([members[r] for r in rng.choice(ur, len(ur))])
        y, p = Y[:, cols].ravel(), P[:, cols].ravel()
        if 0 < y.sum() < len(y):
            bs.append(roc_auc_score(y, p))
            bw.append(within(Y[:, cols], P[:, cols]))
    return {"auroc_mean_within_model": w, "within_lo": float(np.percentile(bw, 2.5)), "within_hi": float(np.percentile(bw, 97.5)),
            "auroc_rows_pooled_across_models": float(point), "lo": float(np.percentile(bs, 2.5)), "hi": float(np.percentile(bs, 97.5))}


def brier_skill(P, Y, repos):
    """Brier skill against the per-model prior estimated on the training repositories (LORO)."""
    prior = np.empty_like(P)
    for r in np.unique(repos):
        te = repos == r
        prior[:, te] = Y[:, ~te].mean(1, keepdims=True)
    return float(1 - ((P - Y) ** 2).mean() / ((prior - Y) ** 2).mean())


def cascade_points(score, Rl, Cl, S_hi, K_hi, thetas):
    """Mean over cheap submissions of (cost, quality) for each threshold; score: (n_cheap, n_task) P(fail)."""
    pts = []
    for th in thetas:
        esc = score > th
        q = np.where(esc, S_hi[None, :], Rl).mean()
        c = (Cl + esc * K_hi[None, :]).mean(0).sum()  # mean over cheap runs, summed over tasks
        pts.append((c, q, esc.mean()))
    return np.array(pts)


def random_points(Rl, Cl, S_hi, K_hi, rates):
    return np.array([(Cl.mean(0).sum() + q * K_hi.sum(), (1 - q) * Rl.mean() + q * S_hi.mean(), q) for q in rates])


def evaluate_cascade(scores, Rl, Cl, S, K, lo, hi, cols=None):
    if cols is not None:
        scores, Rl, Cl, S, K = scores[:, cols], Rl[:, cols], Cl[:, cols], S[cols], K[cols]
    ch = K[:, 2].sum()
    thetas = np.r_[-1, np.quantile(scores, np.linspace(0, 1, 101)), 2]
    det = cascade_points(scores, Rl, Cl, S[:, hi], K[:, hi], thetas)
    perfect = cascade_points(1 - Rl, Rl, Cl, S[:, hi], K[:, hi], [0.5])
    rnd = random_points(Rl, Cl, S[:, hi], K[:, hi], np.linspace(0, 1, 101))
    norm = lambda p: np.column_stack([p[:, 0] / ch, p[:, 1]])
    out = {"detector": curve_metrics(norm(det), S, K), "perfect": curve_metrics(norm(perfect), S, K),
           "random": curve_metrics(norm(rnd), S, K), "mixture": curve_metrics(fixed_points(S, K), S, K)}
    fail_rate = 1 - Rl.mean()
    # matched escalation rate = the cheap tier's failure rate
    j = int(np.argmin(np.abs(det[:, 2] - fail_rate)))
    rq = random_points(Rl, Cl, S[:, hi], K[:, hi], [det[j, 2]])[0]
    out["at_fail_rate"] = {"escalation_rate": float(det[j, 2]),
                           "detector": {"cost_rel": det[j, 0] / ch, "quality": det[j, 1]},
                           "random": {"cost_rel": rq[0] / ch, "quality": rq[1]},
                           "perfect": {"cost_rel": perfect[0, 0] / ch, "quality": perfect[0, 1], "rate": perfect[0, 2]},
                           "share_of_perfect_gain_captured": (det[j, 1] - rq[1]) / (perfect[0, 1] - random_points(Rl, Cl, S[:, hi], K[:, hi], [perfect[0, 2]])[0][1])}
    out["curves"] = {"detector": norm(det), "perfect": norm(perfect), "random": norm(rnd)}
    return out


def main():
    t0 = time.time()
    M = load_matrix()
    repos = M.tasks["repo"].to_numpy()
    res = {"features": FEATURES, "step_limit": STEP_LIMIT, "cost_limit": COST_LIMIT, "method": __doc__,
           "per_instance_fields_found": ["api_calls", "cost", "resolved"]}
    figs = {}
    for si, scheme in enumerate(SCHEMES):
        rng = np.random.default_rng(C.SEED + 10 + si)
        tier = M.tier_idx(scheme)
        all_rows = np.arange(len(tier))
        S, K = shares(M.R, all_rows, tier), costs(M.cost, all_rows, tier)
        sr = {}
        for name, (lo, hi) in CASCADES.items():
            rows = usable(M, np.where(tier == lo)[0])
            dropped = sorted(set(M.subs.submission[np.where(tier == lo)[0]]) - set(M.subs.submission[rows]))
            sc = loro_scores(M, rows, repos)
            Y = np.array([1 - M.R[i] for i in rows])
            Rl = np.array([M.R[i] for i in rows])
            Cl = np.array([M.cost[i] for i in rows])
            calls = np.array([M.calls[i] for i in rows])
            det = {"cheap_submissions": [M.subs.submission[i] for i in rows], "dropped_no_cost_or_calls": dropped,
                   "fail_rate": float(Y.mean()), "unfitted_calls": auroc_block(calls, Y, repos, rng), "per_model": {}}
            for k in ("per_model_lr", "pooled_lr", "features_only"):
                det[k] = auroc_block(sc[k], Y, repos, rng) | {"brier_skill_vs_prior": brier_skill(sc[k], Y, repos)}
            for j, i in enumerate(rows):
                y = Y[j]
                det["per_model"][M.subs.submission[i]] = {
                    "fail_rate": float(y.mean()), "auroc_lr_loro": float(roc_auc_score(y, sc["per_model_lr"][j])),
                    "auroc_pooled_loro": float(roc_auc_score(y, sc["pooled_lr"][j])), "auroc_unfitted_calls": float(roc_auc_score(y, calls[j])),
                    "limit_hit_rate": float(run_features(M.calls[i], M.cost[i])[:, 3].mean())}
            scorers = ("pooled_lr", "features_only", "prior_only")
            ev = {k: evaluate_cascade(sc[k], Rl, Cl, S, K, lo, hi) for k in scorers}
            ur = np.unique(repos)
            members = {r: np.where(repos == r)[0] for r in ur}
            bs = {f"{k}_minus_mixture": [] for k in scorers} | {f"{k}_saved95_minus_mixture": [] for k in scorers}
            bs |= {"pooled_lr_minus_prior_only": [], "features_only_minus_random": [], "perfect_minus_mixture": []}
            for _ in range(N_BOOT // 5):  # 200 repository-cluster resamples
                cols = np.concatenate([members[r] for r in rng.choice(ur, len(ur))])
                e = {k: evaluate_cascade(sc[k], Rl, Cl, S, K, lo, hi, cols) for k in scorers}
                mix = e["pooled_lr"]["mixture"]
                for k in scorers:
                    bs[f"{k}_minus_mixture"].append(e[k]["detector"]["auc_norm"] - mix["auc_norm"])
                    bs[f"{k}_saved95_minus_mixture"].append(e[k]["detector"]["cost_saved_at_95"] - mix["cost_saved_at_95"])
                bs["pooled_lr_minus_prior_only"].append(e["pooled_lr"]["detector"]["auc_norm"] - e["prior_only"]["detector"]["auc_norm"])
                bs["features_only_minus_random"].append(e["features_only"]["detector"]["auc_norm"] - e["features_only"]["random"]["auc_norm"])
                bs["perfect_minus_mixture"].append(e["pooled_lr"]["perfect"]["auc_norm"] - mix["auc_norm"])
            if scheme == SCHEMES[0]:
                figs[name] = {"detector": ev["pooled_lr"]["curves"]["detector"], "features_only": ev["features_only"]["curves"]["detector"],
                              "prior_only": ev["prior_only"]["curves"]["detector"], "random": ev["pooled_lr"]["curves"]["random"],
                              "perfect": ev["pooled_lr"]["curves"]["perfect"], "fixed": fixed_points(S, K)}
            for k in scorers:
                ev[k].pop("curves")
            sr[name] = {"detector": det, "cascade": ev, "bootstrap_repo": {k: ci(v) for k, v in bs.items()}}
            print(scheme, name, round(time.time() - t0), "s", flush=True)
        res[scheme] = sr
    save("stage2_cascade.json", res)
    figure(figs, res)


def figure(figs, res):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axs = plt.subplots(1, 2, figsize=(12, 4.8))
    for ax, name in zip(axs, ("low_to_high", "low_to_mid")):
        f = figs[name]
        fx = f["fixed"]
        for k, c, lab in (("detector", "#0969da", "cascade, run features + model prior (LORO)"), ("features_only", "#54aeff", "cascade, run features only"),
                          ("prior_only", "#8250df", "cascade, model prior only"), ("random", "#bc4c00", "cascade, random escalation"),
                          ("perfect", "#1a7f37", "cascade, perfect detector")):
            p = f[k]
            ax.plot(p[:, 0], p[:, 1], "-" if len(p) > 1 else "*", color=c, ms=12, label=lab)
        ax.plot(fx[:, 0], fx[:, 1], "o--", color="#1f2328", label="fixed tiers / mixture")
        for t, (x, y) in zip(C.TIERS, fx):
            ax.annotate(t, (x, y), textcoords="offset points", xytext=(4, -10), fontsize=8)
        a = res["A_model_terciles"][name]
        ax.set_title(f"Scheme A, {name.replace('_', ' ')}: detector AUROC (within model) {a['detector']['pooled_lr']['auroc_mean_within_model']:.3f}")
        ax.set_xlabel("cost relative to always-high")
        ax.set_ylabel("expected share solved")
        ax.grid(color="#d0d7de", lw=0.6)
        ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage2_cascade.png", dpi=130)


if __name__ == "__main__":
    main()
