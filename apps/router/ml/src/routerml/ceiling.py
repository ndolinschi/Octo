"""Stage 2, part A: the noise ceiling. Is there anything task-level to predict?

1. Split-half reliability of each tier's soft label and of the per-task advantage of a dearer tier.
   Each repetition draws, independently in every tier, a random half of the tier's core submissions; the two
   halves are disjoint. r = Pearson correlation across tasks of the halves' values; reliability of the full-n
   label = Spearman-Brown 2r / (1 + r). 200 repetitions; intervals are the 2.5-97.5 percentiles over repetitions
   (split noise only) and over repetitions that also resample tasks (split + task sampling).
2. Honest oracle: per-task Lagrangian oracle (a = argmax_t S_build - lambda K_build) built on a fraction f of each
   tier's submissions and scored on the disjoint rest. Its curve area minus the fixed-tier mixture's (on the
   scoring part) is a noise-free estimate of what a task-level router knowing the build-part labels gains.
   The in-sample oracle (stage 1, +0.080) fits noise; the cross-fit oracle with raw build labels under-uses the
   signal (its decisions are noisy). A third variant shrinks the build labels toward the tier mean
   (beta-binomial empirical Bayes fitted on the build part only). f in {0.25, 0.5, 0.75} shows the trend in f.
"""

from __future__ import annotations

import time

import numpy as np

from . import config as C
from .evaluate import curve_metrics, fixed_points, utility_points
from .stage2 import SCHEMES, ci, load_matrix, save

N_REP = 200
PAIRS = {"high_minus_low": (2, 0), "mid_minus_low": (1, 0), "high_minus_mid": (2, 1)}


def split_rows(tier: np.ndarray, rng, frac: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    """Disjoint (build, score) submission rows; the fraction is applied inside every tier."""
    a, b = [], []
    for t in range(3):
        r = rng.permutation(np.where(tier == t)[0])
        k = int(round(frac * len(r)))
        k = min(max(k, 1), len(r) - 1)
        a.append(r[:k])
        b.append(r[k:])
    return np.sort(np.concatenate(a)), np.sort(np.concatenate(b))


def shares(R, rows, tier):
    return np.column_stack([R[rows[tier[rows] == t]].mean(0) for t in range(3)])


def costs(cost, rows, tier):
    out = np.empty((cost.shape[1], 3))
    for t in range(3):
        r = rows[tier[rows] == t]
        m = cost[r]
        v = np.nanmean(np.where(np.isnan(m), np.nan, m), axis=0) if not np.isnan(m).all() else np.full(cost.shape[1], np.nan)
        med = np.nanmedian(m) if not np.isnan(m).all() else np.nanmedian(cost[tier == t])
        out[:, t] = np.where(np.isnan(v), med, v)
    return out


def sb(r):
    return 2 * r / (1 + r)


def _corr(x, y):
    if x.std() == 0 or y.std() == 0:
        return np.nan
    return float(np.corrcoef(x, y)[0, 1])


def eb_shrink(S, n):
    """Beta-binomial method-of-moments shrinkage per tier (fitted on the given labels only)."""
    out = S.copy()
    for t in range(3):
        p = S[:, t]
        m, v = p.mean(), p.var()
        bin_v = m * (1 - m) / n[t]
        true_v = max(v - bin_v, 1e-6)
        k = max(m * (1 - m) / true_v - 1, 1e-3)  # prior strength alpha + beta
        out[:, t] = (p * n[t] + m * k) / (n[t] + k)
    return out


def reliability(R, tier, rng):
    rows = {f"tier_{C.TIERS[t]}": [] for t in range(3)} | {k: [] for k in PAIRS}
    rows_boot = {k: [] for k in rows}
    raw_r = {k: [] for k in rows}
    n_task = R.shape[1]
    for _ in range(N_REP):
        a, b = split_rows(tier, rng)
        Sa, Sb = shares(R, a, tier), shares(R, b, tier)
        boot = rng.integers(0, n_task, n_task)
        vals = {f"tier_{C.TIERS[t]}": (Sa[:, t], Sb[:, t]) for t in range(3)}
        for k, (hi, lo) in PAIRS.items():
            vals[k] = (Sa[:, hi] - Sa[:, lo], Sb[:, hi] - Sb[:, lo])
        for k, (x, y) in vals.items():
            r = _corr(x, y)
            raw_r[k].append(r)
            rows[k].append(sb(r))
            rows_boot[k].append(sb(_corr(x[boot], y[boot])))
    return {k: {"split_half_r": ci(raw_r[k]), "reliability_sb": ci(rows[k]), "reliability_sb_with_task_bootstrap": ci(rows_boot[k])}
            for k in rows}


def variance_parts(R, tier):
    """Observed between-task variance of the full-n label and its estimated true part (reliability x variance)."""
    S = shares(R, np.arange(len(tier)), tier)
    out = {}
    for t in range(3):
        out[f"tier_{C.TIERS[t]}_var"] = float(S[:, t].var())
    for k, (hi, lo) in PAIRS.items():
        d = S[:, hi] - S[:, lo]
        out[f"{k}_mean"] = float(d.mean())
        out[f"{k}_var"] = float(d.var())
        out[f"{k}_share_tasks_negative"] = float((d < 0).mean())
    return out


def honest_oracle(R, cost, tier, rng, frac):
    g = {"in_sample_oracle_minus_mixture": [], "crossfit_raw_minus_mixture": [], "crossfit_eb_minus_mixture": [],
         "crossfit_raw_minus_mixture_task_boot": [], "crossfit_eb_minus_mixture_task_boot": [],
         "crossfit_raw_saved95": [], "crossfit_eb_saved95": [], "mixture_saved95": [], "in_sample_saved95": [],
         "crossfit_eb_saved95_minus_mixture": [], "crossfit_raw_saved95_minus_mixture": []}
    n_task = R.shape[1]
    for _ in range(N_REP):
        a, b = split_rows(tier, rng, frac)
        Sa, Sb = shares(R, a, tier), shares(R, b, tier)
        Ka, Kb = costs(cost, a, tier), costs(cost, b, tier)
        na = np.array([(tier[a] == t).sum() for t in range(3)])
        mix = curve_metrics(fixed_points(Sb, Kb), Sb, Kb)
        ins = curve_metrics(utility_points(Sb, Sb, Kb, Kb), Sb, Kb)
        raw = curve_metrics(utility_points(Sa, Sb, Kb, Ka), Sb, Kb)
        Se = eb_shrink(Sa, na)
        eb = curve_metrics(utility_points(Se, Sb, Kb, Ka), Sb, Kb)
        g["in_sample_oracle_minus_mixture"].append(ins["auc_norm"] - mix["auc_norm"])
        g["crossfit_raw_minus_mixture"].append(raw["auc_norm"] - mix["auc_norm"])
        g["crossfit_eb_minus_mixture"].append(eb["auc_norm"] - mix["auc_norm"])
        g["crossfit_raw_saved95"].append(raw["cost_saved_at_95"])
        g["crossfit_eb_saved95"].append(eb["cost_saved_at_95"])
        g["mixture_saved95"].append(mix["cost_saved_at_95"])
        g["in_sample_saved95"].append(ins["cost_saved_at_95"])
        g["crossfit_eb_saved95_minus_mixture"].append(eb["cost_saved_at_95"] - mix["cost_saved_at_95"])
        g["crossfit_raw_saved95_minus_mixture"].append(raw["cost_saved_at_95"] - mix["cost_saved_at_95"])
        bt = rng.integers(0, n_task, n_task)
        Sbb, Kbb = Sb[bt], Kb[bt]
        mixb = curve_metrics(fixed_points(Sbb, Kbb), Sbb, Kbb)["auc_norm"]
        g["crossfit_raw_minus_mixture_task_boot"].append(curve_metrics(utility_points(Sa[bt], Sbb, Kbb, Ka[bt]), Sbb, Kbb)["auc_norm"] - mixb)
        g["crossfit_eb_minus_mixture_task_boot"].append(curve_metrics(utility_points(Se[bt], Sbb, Kbb, Ka[bt]), Sbb, Kbb)["auc_norm"] - mixb)
    return {k: ci(v) for k, v in g.items()}


def main():
    t0 = time.time()
    M = load_matrix()
    res = {"n_rep": N_REP, "seed": C.SEED, "method": __doc__}
    curves = {}
    for si, scheme in enumerate(SCHEMES):
        tier = M.tier_idx(scheme)
        rng = np.random.default_rng(C.SEED + si)
        r = {"n_submissions_per_tier": {C.TIERS[t]: int((tier == t).sum()) for t in range(3)}}
        r["variance"] = variance_parts(M.R, tier)
        r["reliability"] = reliability(M.R, tier, rng)
        S = shares(M.R, np.arange(len(tier)), tier)
        K = costs(M.cost, np.arange(len(tier)), tier)
        r["full_data"] = {"mixture_auc": curve_metrics(fixed_points(S, K), S, K)["auc_norm"],
                          "in_sample_oracle_auc": curve_metrics(utility_points(S, S, K, K), S, K)["auc_norm"]}
        r["full_data"]["in_sample_oracle_minus_mixture"] = r["full_data"]["in_sample_oracle_auc"] - r["full_data"]["mixture_auc"]
        r["honest_oracle"] = {f"build_frac_{f}": honest_oracle(M.R, M.cost, tier, rng, f) for f in (0.25, 0.5, 0.75)}
        res[scheme] = r
        if scheme == SCHEMES[0]:
            a, b = split_rows(tier, np.random.default_rng(C.SEED), 0.5)
            Sa, Sb = shares(M.R, a, tier), shares(M.R, b, tier)
            Ka, Kb = costs(M.cost, a, tier), costs(M.cost, b, tier)
            curves = {"fixed": fixed_points(Sb, Kb), "in_sample": utility_points(Sb, Sb, Kb, Kb),
                      "crossfit_raw": utility_points(Sa, Sb, Kb, Ka),
                      "crossfit_eb": utility_points(eb_shrink(Sa, np.array([(tier[a] == t).sum() for t in range(3)])), Sb, Kb, Ka)}
        print(scheme, round(time.time() - t0), "s", flush=True)
    res["runtime_s"] = round(time.time() - t0)
    save("stage2_ceiling.json", res)
    np.savez(C.RESULTS / "stage2_ceiling_curves.npz", **curves)
    figure(res, curves)


def figure(res, curves):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    from .evaluate import upper_hull

    C.FIGURES.mkdir(exist_ok=True)
    fig, axs = plt.subplots(1, 2, figsize=(12, 4.8))
    ax = axs[0]
    keys = ["tier_low", "tier_mid", "tier_high", "mid_minus_low", "high_minus_mid", "high_minus_low"]
    for si, scheme in enumerate(SCHEMES):
        rel = res[scheme]["reliability"]
        m = [rel[k]["reliability_sb"]["mean"] for k in keys]
        lo = [rel[k]["reliability_sb_with_task_bootstrap"]["lo"] for k in keys]
        hi = [rel[k]["reliability_sb_with_task_bootstrap"]["hi"] for k in keys]
        x = np.arange(len(keys)) + (si - 1) * 0.25
        ax.errorbar(x, m, yerr=[np.subtract(m, lo), np.subtract(hi, m)], fmt="o", capsize=3, label=f"scheme {scheme[0]}")
    ax.set_xticks(range(len(keys)), [k.replace("_minus_", "−").replace("tier_", "") for k in keys], rotation=20)
    ax.set_ylabel("split-half reliability (Spearman-Brown)")
    ax.set_ylim(-0.1, 1)
    ax.axhline(0, color="#6e7781", lw=0.8)
    ax.set_title("Reliability of soft labels and of tier advantages (core)")
    ax.legend(frameon=False)
    ax = axs[1]
    for k, c, lab in (("in_sample", "#1a7f37", "oracle in-sample (fits noise)"), ("crossfit_eb", "#0969da", "oracle built on half 1 (EB), scored on half 2"),
                      ("crossfit_raw", "#8250df", "oracle built on half 1 (raw), scored on half 2")):
        h = upper_hull(np.vstack([curves[k], curves["fixed"][[0, 2]]]))
        ax.plot(h[:, 0], h[:, 1], color=c, label=lab)
    fx = curves["fixed"]
    ax.plot(fx[:, 0], fx[:, 1], "o--", color="#1f2328", label="fixed tiers and their mixture")
    ax.set_xlabel("cost relative to always-high (scoring half)")
    ax.set_ylabel("share solved (scoring half)")
    ax.set_title("Scheme A, one split: how much of the oracle survives cross-fitting")
    ax.legend(frameon=False, fontsize=8)
    for a in axs:
        a.grid(color="#d0d7de", lw=0.6)
    fig.tight_layout()
    fig.savefig(C.FIGURES / "stage2_ceiling.png", dpi=130)


if __name__ == "__main__":
    main()
