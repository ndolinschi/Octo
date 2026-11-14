"""Stage 3, check 1: audit of stage 2's cross-fitted ceiling, and run-to-run agreement of the same model.

Part 1 (ceiling audit). Re-plays stage 2's random-number sequence exactly (ceiling.main consumes the generator in
the order reliability -> honest_oracle(f=0.25) -> honest_oracle(f=0.5)), records every split's gain instead of only
its interval, and recomputes the area with an independent exact integration of the piecewise-linear hull.
Variants that probe the area definition:
  stage2      oracle points + fixed LOW and HIGH only (stage 2's curve_metrics), minus the fixed-tier hull
  with_mid    the router may also mix with fixed MID (hull of oracle points + all three fixed points); >= stage2
  mix_build   baseline = the fixed-tier mixture whose tiers are chosen on the BUILD half (fixed-tier hull of the
              build half decides which fixed tiers are on the hull; its operating points are then scored on the
              scoring half), i.e. the baseline gets no more information than the oracle
Part 2 (run-to-run). Every core model with more than one submission; for each pair of runs of the same model:
solve rates, share of tasks where the runs differ, phi (= Pearson on 0/1), Cohen's kappa. Confounded by the
scaffold version and the reasoning effort, which differ inside most pairs.
"""

from __future__ import annotations

import itertools

import numpy as np

from . import config as C
from .ceiling import N_REP, costs, eb_shrink, honest_oracle, reliability, shares, split_rows
from .evaluate import curve_metrics, fixed_points, upper_hull, utility_points
from .stage2 import SCHEMES, ci, load_matrix, save


def exact_area(pts, xl):
    """Exact mean height of the upper hull over [xl, 1] (piecewise-linear integral, flat after the last point)."""
    h = upper_hull(pts)
    xs = np.r_[xl, h[:, 0][(h[:, 0] > xl) & (h[:, 0] < 1)], 1.0]
    ys = np.interp(xs, h[:, 0], h[:, 1])
    return float(np.sum((ys[1:] + ys[:-1]) / 2 * np.diff(xs)) / (1 - xl))


def split_gains(Sa, Sb, Ka, Kb, na):
    fxb = fixed_points(Sb, Kb)
    xl = fxb[0, 0]
    mix = curve_metrics(fxb, Sb, Kb)["auc_norm"]
    out = {}
    for name, P in (("raw", Sa), ("eb", eb_shrink(Sa, na))):
        pts = utility_points(P, Sb, Kb, Ka)
        out[f"{name}_stage2"] = curve_metrics(pts, Sb, Kb)["auc_norm"] - mix
        out[f"{name}_exact"] = exact_area(np.vstack([pts, fxb[[0, 2]]]), xl) - exact_area(fxb, xl)
        out[f"{name}_with_mid"] = exact_area(np.vstack([pts, fxb]), xl) - exact_area(fxb, xl)
    # baseline chosen on the build half: which fixed tiers lie on the build half's hull
    fxa = fixed_points(Sa, Ka)
    on_hull = [t for t in range(3) if any(np.allclose(fxa[t], p) for p in upper_hull(fxa))]
    out["mix_build_minus_mix"] = exact_area(fxb[on_hull + ([0] if 0 not in on_hull else []) + ([2] if 2 not in on_hull else [])], xl) - exact_area(fxb, xl)
    out["eb_minus_mix_build"] = out["eb_exact"] - out["mix_build_minus_mix"]
    chord = fxb[0, 1] + (fxb[2, 1] - fxb[0, 1]) * (fxb[1, 0] - fxb[0, 0]) / (fxb[2, 0] - fxb[0, 0])
    out["mid_lift_over_chord"] = fxb[1, 1] - chord
    out["x_low"] = xl
    out["q_low"], out["q_mid"], out["q_high"] = fxb[:, 1]
    return out


def replay(M, si, scheme):
    """Exactly stage 2's sequence of splits for f = 0.5 (same seed, same order of draws)."""
    tier = M.tier_idx(scheme)
    rng = np.random.default_rng(C.SEED + si)
    reliability(M.R, tier, rng)
    honest_oracle(M.R, M.cost, tier, rng, 0.25)
    rows = []
    n_task = M.R.shape[1]
    for _ in range(N_REP):
        a, b = split_rows(tier, rng, 0.5)
        Sa, Sb = shares(M.R, a, tier), shares(M.R, b, tier)
        Ka, Kb = costs(M.cost, a, tier), costs(M.cost, b, tier)
        na = np.array([(tier[a] == t).sum() for t in range(3)])
        rows.append(split_gains(Sa, Sb, Ka, Kb, na))
        rng.integers(0, n_task, n_task)  # stage 2's task bootstrap draw, kept to stay in sequence
    return rows


def dist(x):
    x = np.asarray(x, float)
    q = np.percentile(x, [2.5, 10, 25, 50, 75, 90, 97.5])
    return {"mean": x.mean(), "sd": x.std(), "median": q[3], "q2.5": q[0], "q10": q[1], "q25": q[2], "q75": q[4],
            "q90": q[5], "q97.5": q[6], "share_above_0": float((x > 0).mean()), "n": len(x)}


def plotted_split(M):
    tier = M.tier_idx(SCHEMES[0])
    a, b = split_rows(tier, np.random.default_rng(C.SEED), 0.5)
    Sa, Sb = shares(M.R, a, tier), shares(M.R, b, tier)
    Ka, Kb = costs(M.cost, a, tier), costs(M.cost, b, tier)
    na = np.array([(tier[a] == t).sum() for t in range(3)])
    g = split_gains(Sa, Sb, Ka, Kb, na)
    npz = np.load(C.RESULTS / "stage2_ceiling_curves.npz")
    fx = npz["fixed"]
    xl = fx[0, 0]
    hand = {k: exact_area(np.vstack([npz[k], fx[[0, 2]]]), xl) - exact_area(fx, xl) for k in ("crossfit_eb", "crossfit_raw", "in_sample")}
    # largest vertical gap between EB curve and the mixture, and where
    he, hm = upper_hull(np.vstack([npz["crossfit_eb"], fx[[0, 2]]])), upper_hull(fx)
    xs = np.linspace(xl, 1, 401)
    gap = np.interp(xs, he[:, 0], he[:, 1]) - np.interp(xs, hm[:, 0], hm[:, 1])
    return {"recomputed": g, "hand_from_plotted_points": hand, "max_vertical_gap": float(gap.max()),
            "at_cost": float(xs[gap.argmax()]), "fixed_points_scoring_half": fx.tolist(),
            "eb_hull_points": he.tolist()}


def pair_agreement(M):
    subs = M.subs.reset_index(drop=True)
    out = []
    for canon, g in subs.groupby("canon"):
        if len(g) < 2:
            continue
        for i, j in itertools.combinations(g.index, 2):
            x, y = M.R[i], M.R[j]
            p1, p2 = x.mean(), y.mean()
            po = (x == y).mean()
            pe = p1 * p2 + (1 - p1) * (1 - p2)
            n11, n10, n01, n00 = ((x == 1) & (y == 1)).sum(), ((x == 1) & (y == 0)).sum(), ((x == 0) & (y == 1)).sum(), ((x == 0) & (y == 0)).sum()
            # task bootstrap for kappa
            rng = np.random.default_rng(C.SEED + i * 100 + j)
            ks = []
            for _ in range(1000):
                bt = rng.integers(0, len(x), len(x))
                xb, yb = x[bt], y[bt]
                a1, a2 = xb.mean(), yb.mean()
                pe_b = a1 * a2 + (1 - a1) * (1 - a2)
                ks.append(((xb == yb).mean() - pe_b) / (1 - pe_b))
            out.append({"model": canon, "run_1": subs.submission[i], "run_2": subs.submission[j],
                        "effort_1": subs.reasoning_effort[i], "effort_2": subs.reasoning_effort[j],
                        "rate_1": p1, "rate_2": p2, "share_differ": 1 - po, "phi": float(np.corrcoef(x, y)[0, 1]),
                        "kappa": (po - pe) / (1 - pe), "kappa_ci": ci(ks), "n11": n11, "n10": n10, "n01": n01, "n00": n00,
                        "share_differ_if_independent": 1 - pe})
    return out


def between_model_reference(M):
    """For comparison: the same statistics between DIFFERENT models of the same tier (scheme A)."""
    tier = M.tier_idx(SCHEMES[0])
    canon = M.subs.canon.to_numpy()
    res = {}
    for t in range(3):
        idx = np.where(tier == t)[0]
        d, k = [], []
        for i, j in itertools.combinations(idx, 2):
            if canon[i] == canon[j]:
                continue
            x, y = M.R[i], M.R[j]
            po = (x == y).mean()
            pe = x.mean() * y.mean() + (1 - x.mean()) * (1 - y.mean())
            d.append(1 - po)
            k.append((po - pe) / (1 - pe))
        res[C.TIERS[t]] = {"n_pairs": len(d), "share_differ_mean": float(np.mean(d)), "kappa_mean": float(np.mean(k)),
                           "kappa_q10_q90": [float(np.percentile(k, 10)), float(np.percentile(k, 90))]}
    return res


def main():
    M = load_matrix()
    res = {"method": __doc__, "plotted_split_scheme_A": plotted_split(M)}
    for si, scheme in enumerate(SCHEMES):
        rows = replay(M, si, scheme)
        keys = rows[0].keys()
        res[scheme] = {k: dist([r[k] for r in rows]) for k in keys}
        mid = np.array([r["mid_lift_over_chord"] for r in rows])
        eb = np.array([r["eb_stage2"] for r in rows])
        res[scheme]["corr_gain_vs_mid_lift"] = float(np.corrcoef(mid, eb)[0, 1])
        print(scheme, {k: round(res[scheme][k]["mean"], 4) for k in ("eb_stage2", "eb_exact", "eb_with_mid", "eb_minus_mix_build")}, flush=True)
    res["same_model_pairs"] = pair_agreement(M)
    res["different_models_same_tier_A"] = between_model_reference(M)
    save("stage3_ceiling_audit.json", res)


if __name__ == "__main__":
    main()
