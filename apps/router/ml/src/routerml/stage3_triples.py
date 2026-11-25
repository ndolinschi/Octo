"""Stage 3, check 2: concrete models instead of price tiers.

Triples (cheap, mid, dear), declared before any per-task outcome of these models was read. Rules use only the
price table, the submission metadata and the public leaderboard solve rate (which a ladder designer has):
  T1 "OpenAI GPT-5 family": the nano / mini / full models of one release, one scaffold version and one effort
     (v1.7.0, 2025-08-07, medium): gpt-5-nano / gpt-5-mini / gpt-5.
  T2 "Anthropic 4.5 family": haiku / sonnet / opus of one release batch (v2.0.0, 2026-02-17, high):
     claude-haiku-4.5 / claude-sonnet-4.5 / claude-opus-4.5.
  T3 "cross-provider, strongest per band": scheme A price bands (< 0.80, 0.80-3.44, > 3.44 $/M), the 2026-02-17
     v2.0.0 batch (one scaffold version), the highest leaderboard solve rate per band:
     minimax-m2.5 / gemini-3-flash / claude-opus-4.5.
  T4 "cross-provider, cheapest per band": same batch and bands, the lowest price per band:
     deepseek-v3.2 / gemini-3-flash / gpt-5.2.
Per triple: solve rates and mean costs; the 2x2x2 outcome table; the curve-area gain of the per-task oracle over the
best mixture of the three fixed models (stage 1's area; oracle hull with all three fixed points = the corrected
definition of check 1). Single runs make the oracle optimistic; it is bounded by simulating two noisy copies of
every run whose disagreement matches check 1's run-to-run rate (0.168 for the cheap band from gpt-5-mini,
0.12 for mid and dear from the strong-model pairs): latent solve probability pi = y(1-a) + (1-y)b with the marginal
kept and E[2 pi (1-pi)] = d; the oracle is built on copy 1 and scored on copy 2 (200 simulations).
Prediction of z = "cheap fails and dear solves": (i) routing-time text features (stage 1's text statistics +
MiniLM PCA-16 fitted in fold), logistic regression; (ii) the cheap run's first K = 5, 10, 20 steps (stage 2's
early_features), logistic regression; both leave-one-repository-out, AUROC with 1000 repository bootstraps; the
prior has AUROC 0.5. Cascade cheap -> dear with honest cost: the cheap run's cost up to the stop (per-step cost
where recorded, else the linear share) plus the dear run's full cost; outcome = the dear run's when stopped.
"""

from __future__ import annotations

import json
import pickle
import time

import numpy as np
from scipy.optimize import brentq
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from . import config as C
from .evaluate import fixed_points, upper_hull, utility_points
from .features import routing_view, text_stats
from .stage2 import ci, load_matrix, save
from .stage3_audit import exact_area
from .trajectories import KS, cost_to, features_at, parse
from .traj_fetch import TRAJ_DIR

TRIPLES = {
    "T1_openai_gpt5_family": ("20250807_mini-v1.7.0_gpt-5-nano", "20250807_mini-v1.7.0_gpt-5-mini", "20250807_mini-v1.7.0_gpt-5"),
    "T2_anthropic_4.5_family": ("20260217_mini-v2.0.0_claude-4-5-haiku-high", "20260217_mini-v2.0.0_claude-4-5-sonnet-high", "20260217_mini-v2.0.0_claude-4-5-opus-high"),
    "T3_strongest_per_band": ("20260217_mini-v2.0.0_minimax-2-5-high", "20260217_mini-v2.0.0_gemini-3-flash-high", "20260217_mini-v2.0.0_claude-4-5-opus-high"),
    "T4_cheapest_per_band": ("20260217_mini-v2.0.0_deepseek-3-2-high", "20260217_mini-v2.0.0_gemini-3-flash-high", "20260217_mini-v2.0.0_gpt-5-2-high"),
}
NOISE = (0.168, 0.12, 0.12)
N_SIM = 200
N_BOOT = 1000


def area_gain(S, K, P=None, cbar=None):
    """Oracle (or rule with scores P) area minus the fixed-model mixture's, both over [x_cheap, 1] (exact)."""
    fx = fixed_points(S, K)
    xl = fx[0, 0]
    pts = utility_points(S if P is None else P, S, K, K if cbar is None else cbar)
    return exact_area(np.vstack([pts, fx]), xl) - exact_area(fx, xl), fx


def latent(y, d):
    r = y.mean()
    if r in (0, 1):
        return y.astype(float)

    def f(a):
        b = r * a / (1 - r)
        return r * 2 * a * (1 - a) + (1 - r) * 2 * b * (1 - b) - d

    a = brentq(f, 1e-9, min(0.5, 0.5 * (1 - r) / r))
    b = r * a / (1 - r)
    return np.where(y == 1, 1 - a, b)


def noisy_oracle(S, K, rng):
    Pi = np.column_stack([latent(S[:, j], NOISE[j]) for j in range(3)])
    g_cross, g_in, g_true = [], [], []
    for _ in range(N_SIM):
        A = (rng.random(Pi.shape) < Pi).astype(float)
        B = (rng.random(Pi.shape) < Pi).astype(float)
        g_cross.append(area_gain(B, K, P=A)[0])
        g_in.append(area_gain(B, K)[0])
        g_true.append(area_gain(B, K, P=Pi)[0])
    return {"oracle_on_copy1_scored_on_copy2": ci(g_cross), "in_sample_on_a_copy": ci(g_in),
            "oracle_knowing_latent_pi_scored_on_a_copy": ci(g_true),
            "check_disagreement_per_model": [float(np.mean(2 * Pi[:, j] * (1 - Pi[:, j]))) for j in range(3)]}


def boot_auroc(y, p, repos, rng):
    ur = np.unique(repos)
    mem = {r: np.where(repos == r)[0] for r in ur}
    vals = []
    for _ in range(N_BOOT):
        idx = np.concatenate([mem[r] for r in rng.choice(ur, len(ur))])
        if 0 < y[idx].sum() < len(idx):
            vals.append(roc_auc_score(y[idx], p[idx]))
    return {"point": float(roc_auc_score(y, p)), **{k: v for k, v in ci(vals).items() if k != "mean"}}


def loro_lr(X, y, repos, Cr=0.3, pca_cols=None, n_pca=16):
    P = np.zeros(len(y))
    for r in np.unique(repos):
        te, tr = repos == r, repos != r
        A, B = X[tr], X[te]
        if pca_cols is not None:
            pca = PCA(n_pca, random_state=C.SEED).fit(pca_cols[tr])
            A, B = np.hstack([A, pca.transform(pca_cols[tr])]), np.hstack([B, pca.transform(pca_cols[te])])
        mu, sd = A.mean(0), A.std(0)
        sd = np.where(sd < 1e-9, 1, sd)
        if y[tr].sum() == 0:
            P[te] = 0
            continue
        P[te] = LogisticRegression(C=Cr, max_iter=3000).fit((A - mu) / sd, y[tr]).predict_proba((B - mu) / sd)[:, 1]
    return P


def load_trajs(sub, ids):
    d = TRAJ_DIR / sub
    if not d.exists():
        return None
    cache = C.DATA / f"stage3_traj_{sub}.pkl"
    if cache.exists():
        return pickle.loads(cache.read_bytes())
    recs = {}
    for i in ids:
        f = d / f"{i}.traj.json"
        try:
            recs[i] = parse(json.loads(f.read_text()))
        except Exception as e:  # noqa: BLE001
            recs[i] = {"error": repr(e)[:200]}
    cache.write_bytes(pickle.dumps(recs))
    return recs


def cascade_curve(score, yc, cc, ck, yd, cd, thetas):
    pts = []
    for th in thetas:
        stop = score > th
        q = np.where(stop, yd, yc).mean()
        c = np.where(stop, ck + cd, cc).sum()
        pts.append((c, q, stop.mean()))
    return np.array(pts)


def cascade_gain(pts_abs, S, K):
    """Area of hull(cascade points + fixed models) minus the fixed-model mixture, both relative to always-dear."""
    ch = K[:, 2].sum()
    fx = fixed_points(S, K)
    xl = fx[0, 0]
    pts = np.column_stack([pts_abs[:, 0] / ch, pts_abs[:, 1]])
    return exact_area(np.vstack([pts, fx]), xl) - exact_area(fx, xl)


def run_triple(name, subs, M, view, stats, emb, rng):
    idx = [int(np.where(M.subs.submission == s)[0][0]) for s in subs]
    S = M.R[idx].T
    K = M.cost[idx].T.copy()
    for j in range(3):
        K[np.isnan(K[:, j]), j] = np.nanmedian(K[:, j])
    repos = M.tasks["repo"].to_numpy()
    out = {"submissions": subs, "models": M.subs.canon.iloc[idx].tolist(),
           "price_blended_per_m": M.subs.blended_per_m.iloc[idx].tolist(),
           "solve_rate": S.mean(0).tolist(), "mean_cost_usd": K.mean(0).tolist(),
           "cost_missing_cells": int(np.isnan(M.cost[idx]).sum())}
    pat = {}
    for a in (0, 1):
        for b in (0, 1):
            for c in (0, 1):
                pat[f"cheap{a}_mid{b}_dear{c}"] = int(((S[:, 0] == a) & (S[:, 1] == b) & (S[:, 2] == c)).sum())
    out["outcome_table"] = pat
    out["only_dear_solves"] = pat["cheap0_mid0_dear1"]
    out["only_cheap_solves"] = pat["cheap1_mid0_dear0"]
    out["cheap_fails_dear_solves"] = int(((S[:, 0] == 0) & (S[:, 2] == 1)).sum())
    out["cheap_solves_dear_fails"] = int(((S[:, 0] == 1) & (S[:, 2] == 0)).sum())
    g, fx = area_gain(S, K)
    out["fixed_points"] = fx.tolist()
    out["mixture_area"] = exact_area(fx, fx[0, 0])
    out["oracle_in_sample_gain"] = g
    out["noise_bound"] = noisy_oracle(S, K, rng)
    # cheap-vs-dear pair only (two-model ladder)
    S2, K2 = S[:, [0, 0, 2]], K[:, [0, 0, 2]]
    out["oracle_in_sample_gain_cheap_dear_only"] = area_gain(S2, K2)[0]
    z = ((S[:, 0] == 0) & (S[:, 2] == 1)).astype(int)
    out["z_rate"] = float(z.mean())
    st = stats.to_numpy(float)
    Pt = loro_lr(st, z, repos, pca_cols=emb)
    out["text_auroc_z"] = boot_auroc(z, Pt, repos, rng)
    Ps = loro_lr(st, z, repos)
    out["text_stats_only_auroc_z"] = boot_auroc(z, Ps, repos, rng)
    out["length_heuristic_auroc_z"] = boot_auroc(z, np.log1p(view["problem_statement"].str.len().to_numpy()), repos, rng)
    # text-feature router: utility rule on predicted P(solve) per model, LORO
    Pm = np.column_stack([loro_lr(st, S[:, j].astype(int), repos, pca_cols=emb) for j in range(3)])
    cbar = np.zeros_like(K)
    for r in np.unique(repos):
        te, tr = repos == r, repos != r
        cbar[te] = K[tr].mean(0)
    out["text_router_gain"] = area_gain(S, K, P=Pm, cbar=cbar)[0]
    recs = load_trajs(subs[0], M.tasks["instance_id"].tolist())
    if recs is None:
        out["trajectories"] = "cheap model's trajectories not available"
        return out
    ids = M.tasks["instance_id"].tolist()
    ok = np.array(["error" not in recs.get(i, {"error": 1}) for i in ids])
    out["trajectories_parsed"] = int(ok.sum())
    thetas = np.r_[-1, np.linspace(0, 1, 101), 2]
    out["early"] = {}
    yc, cc, yd, cd = S[:, 0], K[:, 0], S[:, 2], K[:, 2]
    for Kst in KS:
        X = np.array([features_at(recs[i], Kst) if ok[j] else np.zeros(21) for j, i in enumerate(ids)])
        ended = np.array([len(recs[i]["steps"]) <= Kst if ok[j] else True for j, i in enumerate(ids)])
        ck = np.array([cost_to(recs[i], Kst, cc[j])[0] if ok[j] else cc[j] for j, i in enumerate(ids)])
        kinds = [cost_to(recs[i], Kst, cc[j])[1] if ok[j] else "missing" for j, i in enumerate(ids)]
        Pz = loro_lr(X, z, repos)
        Pf = loro_lr(X, (1 - yc).astype(int), repos)
        e = {"auroc_z": boot_auroc(z, Pz, repos, rng), "auroc_cheap_fails": boot_auroc((1 - yc).astype(int), Pf, repos, rng),
             "share_ended_by_K": float(ended.mean()), "cost_kind": {k: kinds.count(k) for k in set(kinds)},
             "cheap_cost_to_K_share": float(ck.sum() / cc.sum())}
        Pf_eff = np.where(ended, -1.0, Pf)  # a run that ended by K cannot be stopped early
        Pz_eff = np.where(ended, -1.0, Pz)
        for nm, sc in (("detector_cheap_fails", Pf_eff), ("detector_z", Pz_eff), ("perfect_stop_if_cheap_fails", np.where(ended, -1.0, 1.0 - yc)),
                       ("random", np.where(ended, -1.0, rng.random(len(yc))))):
            pts = cascade_curve(sc, yc, cc, ck, yd, cd, thetas)
            e[f"cascade_gain_{nm}"] = cascade_gain(pts, S, K)
        bs = []
        ur = np.unique(repos)
        mem = {r: np.where(repos == r)[0] for r in ur}
        for _ in range(200):
            b = np.concatenate([mem[r] for r in rng.choice(ur, len(ur))])
            pts = cascade_curve(Pf_eff[b], yc[b], cc[b], ck[b], yd[b], cd[b], thetas)
            bs.append(cascade_gain(pts, S[b], K[b]))
        e["cascade_gain_detector_cheap_fails_ci"] = ci(bs)
        out["early"][f"K{Kst}"] = e
    return out


def main():
    t0 = time.time()
    M = load_matrix()
    view = routing_view(M.tasks)
    stats = text_stats(view)
    emb = np.load(C.DATA / "embeddings_minilm.npy")
    res = {"method": __doc__, "triples": {}}
    for i, (name, subs) in enumerate(TRIPLES.items()):
        rng = np.random.default_rng(C.SEED + 400 + i)
        res["triples"][name] = run_triple(name, subs, M, view, stats, emb, rng)
        print(name, round(time.time() - t0), "s", flush=True)
        save("stage3_triples.json", res)


if __name__ == "__main__":
    main()
