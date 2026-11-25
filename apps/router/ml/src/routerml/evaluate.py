"""Stage 3: M1 (LightGBM) and baselines under leave-one-repository-out, time and grouped k-fold splits.

Everything a split's test fold sees was fitted on its training fold only: TF-IDF/SVD, the embedding PCA,
the hyper-parameter choice (inner GroupKFold by repository), the calibrators (on inner out-of-fold
predictions) and the operating threshold tau95. Seeds: config.SEED.
"""

from __future__ import annotations

import argparse
import itertools
import json
import time
import warnings

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

from . import config as C
from .build import load_tasks
from .features import STAT_COLUMNS, TfidfSvd, routing_view, text_stats

warnings.filterwarnings("ignore", category=UserWarning)

TAUS = np.r_[np.linspace(0.0, 1.0, 101), 1.01]
# Pre-declared grid (declared before the first run; never tuned on test folds).
GRID = [dict(num_leaves=nl, n_estimators=ne) for nl, ne in itertools.product((4, 15), (100, 400))]
BASE = dict(learning_rate=0.03, min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.5,
            reg_lambda=1.0, verbose=-1, n_jobs=2)
FEATURE_SETS = ("stats", "stats+tfidf", "stats+tfidf+emb")
N_SVD, N_PCA = 32, 32


# ----------------------------------------------------------------------------------- data
def load(scheme: str, sl: str):
    tasks = load_tasks().sort_values("instance_id").reset_index(drop=True)
    lab = pd.read_csv(C.RESULTS / f"labels_{scheme}_{sl}.csv")
    ids = tasks["instance_id"].tolist()
    S = lab.pivot(index="instance_id", columns="tier", values="share").loc[ids, list(C.TIERS)].to_numpy()
    K = lab.pivot(index="instance_id", columns="tier", values="cost").loc[ids, list(C.TIERS)].to_numpy()
    return tasks, S, K


class FoldFeatures:
    def __init__(self, view: pd.DataFrame, stats: pd.DataFrame, emb: np.ndarray, fset: str):
        self.view, self.stats, self.emb, self.fset = view, stats.to_numpy(float), emb, fset

    def fit(self, idx):
        if "tfidf" in self.fset:
            self.tf = TfidfSvd(N_SVD).fit(self.view.iloc[idx])
        if "emb" in self.fset:
            self.pca = PCA(N_PCA, random_state=C.SEED).fit(self.emb[idx])
        return self

    def transform(self, idx):
        blocks = [self.stats[idx]]
        if "tfidf" in self.fset:
            blocks.append(self.tf.transform(self.view.iloc[idx]))
        if "emb" in self.fset:
            blocks.append(self.pca.transform(self.emb[idx]))
        return np.hstack(blocks)

    def names(self):
        n = list(STAT_COLUMNS)
        if "tfidf" in self.fset:
            n += [f"svd_{i}" for i in range(N_SVD)]
        if "emb" in self.fset:
            n += [f"emb_pca_{i}" for i in range(N_PCA)]
        return n


def expand(X, S, tiers=(0, 1, 2), with_tier=True):
    """(task, tier) cell -> two weighted rows (y=1 weight share, y=0 weight 1-share)."""
    Xs, ys, ws = [], [], []
    for t in tiers:
        Xt = np.hstack([X, np.full((len(X), 1), t)]) if with_tier else X
        Xs += [Xt, Xt]
        ys += [np.ones(len(X)), np.zeros(len(X))]
        ws += [S[:, t], 1 - S[:, t]]
    return np.vstack(Xs), np.concatenate(ys), np.concatenate(ws)


def _fit(params, X, y, w, seed):
    m = lgb.LGBMClassifier(**BASE, **params, random_state=seed)
    m.fit(X, y, sample_weight=w)
    return m


def _wll(p, S):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(S * np.log(p) + (1 - S) * np.log(1 - p)).mean())


class M1:
    """joint: one model, tier as an input. per_tier: three models."""

    def __init__(self, kind="joint", seed=C.SEED):
        self.kind, self.seed = kind, seed

    def _fit_all(self, params, X, S):
        if self.kind == "joint":
            return [_fit(params, *expand(X, S), self.seed)]
        return [_fit(params, *expand(X, S[:, [t]], tiers=(0,), with_tier=False), self.seed) for t in range(3)]

    def _pred(self, models, X):
        if self.kind == "joint":
            return np.column_stack([models[0].predict_proba(np.hstack([X, np.full((len(X), 1), t)]))[:, 1] for t in range(3)])
        return np.column_stack([m.predict_proba(X)[:, 1] for m in models])

    def fit(self, ff: FoldFeatures, idx, S, groups):
        """Inner GroupKFold(3) by repository selects params and yields OOF predictions for calibration."""
        inner = GroupKFold(n_splits=3)
        best = None
        for params in GRID:
            oof = np.zeros((len(idx), 3))
            for a, b in inner.split(idx, groups=groups[idx]):
                ffi = FoldFeatures(ff.view, pd.DataFrame(ff.stats), ff.emb, ff.fset).fit(idx[a])
                ms = self._fit_all(params, ffi.transform(idx[a]), S[idx[a]])
                oof[b] = self._pred(ms, ffi.transform(idx[b]))
            loss = _wll(oof, S[idx])
            if best is None or loss < best[0]:
                best = (loss, params, oof)
        self.inner_loss, self.params, self.oof = best
        ff.fit(idx)
        self.models = self._fit_all(self.params, ff.transform(idx), S[idx])
        self.ff = ff
        # calibrators per tier on inner OOF predictions
        self.iso, self.platt = [], []
        for t in range(3):
            p, s = self.oof[:, t], S[idx, t]
            self.iso.append(IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(p, s))
            z = _logit(p)[:, None]
            lr = LogisticRegression(C=1e6).fit(np.r_[z, z], np.r_[np.ones(len(z)), np.zeros(len(z))], sample_weight=np.r_[s, 1 - s])
            self.platt.append(lr)
        return self

    def predict(self, idx):
        raw = self._pred(self.models, self.ff.transform(idx))
        iso = np.column_stack([self.iso[t].predict(raw[:, t]) for t in range(3)])
        platt = np.column_stack([self.platt[t].predict_proba(_logit(raw[:, t])[:, None])[:, 1] for t in range(3)])
        return {"raw": raw, "isotonic": iso, "platt": platt}


def _logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


# ----------------------------------------------------------------------------------- metrics
def policy(P, tau):
    ok = P >= tau
    return np.where(ok.any(1), ok.argmax(1), 2)


def curve_points(P, S, K):
    """(cost relative to always-high, expected share solved) for each tau."""
    ch = K[:, 2].sum()
    pts = []
    for tau in TAUS:
        a = policy(P, tau)
        r = np.arange(len(a))
        pts.append((K[r, a].sum() / ch, S[r, a].mean()))
    return np.array(pts)


LAMBDAS = np.r_[0.0, np.geomspace(1e-3, 1e3, 120)]


def utility_points(P, S, K, cbar):
    """Alternative rule: a = argmax_t P[t] - lambda * cbar[t] (cbar = training-fold mean cost per tier).
    With P = S and cbar = K (true per-task costs) this is the Lagrangian oracle: the exact upper hull of
    the per-task knapsack, i.e. the best any router can do with these soft labels."""
    ch = K[:, 2].sum()
    r = np.arange(len(S))
    pts = []
    for lam in LAMBDAS:
        a = np.argmax(P - lam * cbar, axis=1)
        pts.append((K[r, a].sum() / ch, S[r, a].mean()))
    return np.array(pts)


def fixed_points(S, K):
    ch = K[:, 2].sum()
    return np.array([(K[:, t].sum() / ch, S[:, t].mean()) for t in range(3)])


def upper_hull(pts):
    """Upper concave envelope, monotone non-decreasing (mixing policies makes every hull point reachable)."""
    p = pts[np.lexsort((-pts[:, 1], pts[:, 0]))]
    hull = []
    for x, y in p:
        if hull and y <= hull[-1][1]:
            continue  # dominated: costs more, solves no more
        while len(hull) >= 2:
            (x1, y1), (x2, y2) = hull[-2], hull[-1]
            if (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) >= 0:
                hull.pop()
            else:
                break
        hull.append((x, y))
    return np.array(hull)


def hull_value(h, x):
    if x <= h[0, 0]:
        return h[0, 1] if x == h[0, 0] else np.nan
    return float(np.interp(x, h[:, 0], h[:, 1]))


def curve_metrics(pts, S, K):
    fx = fixed_points(S, K)
    xl, ql, qh = fx[0, 0], fx[0, 1], fx[2, 1]
    allp = np.vstack([pts, fx[[0, 2]]])
    h = upper_hull(allp)
    xs = np.linspace(xl, 1.0, 201)
    ys = np.array([hull_value(h, x) for x in xs])
    auc = float(np.trapezoid(ys, xs) / (1 - xl))
    chord = (ql + qh) / 2
    res = {"auc_norm": auc, "auc_lift_over_chord": auc - chord, "q_low": ql, "q_high": qh, "x_low": xl}
    for lvl in (0.95, 0.99):
        target = lvl * qh
        ok = xs[ys >= target]
        res[f"cost_saved_at_{int(lvl*100)}"] = float(1 - ok.min()) if len(ok) else 0.0
    return res


def ece(p, s, bins=10):
    e = np.minimum((p * bins).astype(int), bins - 1)
    return float(sum(abs(p[e == b].mean() - s[e == b].mean()) * (e == b).mean() for b in range(bins) if (e == b).any()))


def prob_metrics(P, S, prior):
    out = {}
    for t, name in enumerate(C.TIERS):
        hard = (S[:, t] > 0.5).astype(int)
        auroc = roc_auc_score(hard, P[:, t]) if 0 < hard.sum() < len(hard) else np.nan
        brier = float(((P[:, t] - S[:, t]) ** 2).mean())
        bprior = float(((prior[t] - S[:, t]) ** 2).mean())
        out[name] = {"auroc_vs_majority": auroc, "brier_vs_soft": brier, "brier_prior": bprior,
                     "brier_skill_vs_prior": 1 - brier / bprior if bprior > 0 else np.nan, "ece": ece(P[:, t], S[:, t])}
    return out


def pick_tau(P_oof, S_tr, K_tr, level=0.95):
    """Cheapest tau on the training fold's OOF predictions reaching `level` x always-high quality."""
    qh = S_tr[:, 2].mean()
    best = (np.inf, 1.01)
    r = np.arange(len(S_tr))
    for tau in TAUS:
        a = policy(P_oof, tau)
        if S_tr[r, a].mean() >= level * qh:
            c = K_tr[r, a].sum()
            if c < best[0]:
                best = (c, tau)
    return best[1]


# ----------------------------------------------------------------------------------- splits
def splits(tasks, kind):
    repos = tasks["repo"].to_numpy()
    if kind == "loro":
        for r in sorted(set(repos)):
            yield r, np.where(repos != r)[0], np.where(repos == r)[0]
    elif kind == "time":
        order = np.argsort(tasks["created_at"].to_numpy())
        cut = int(0.7 * len(order))
        yield "time", np.sort(order[:cut]), np.sort(order[cut:])
    elif kind == "gkf4":
        for i, (a, b) in enumerate(GroupKFold(n_splits=4).split(tasks, groups=repos)):
            yield f"fold{i}", a, b


def run(scheme="A_model_terciles", sl="core", fset="stats+tfidf+emb", split="loro", kind="joint", seed=C.SEED, store=None):
    tasks, S, K = load(scheme, sl)
    view = routing_view(tasks)
    stats = text_stats(view)
    emb = np.load(C.DATA / "embeddings_minilm.npy")
    groups = tasks["repo"].to_numpy()
    n = len(tasks)
    preds = {k: np.full((n, 3), np.nan) for k in ("raw", "isotonic", "platt", "prior")}
    tested = np.zeros(n, bool)
    fold_of = np.empty(n, object)
    tau95 = np.full(n, np.nan)
    cbar = np.full((n, 3), np.nan)
    h = stats["len_chars"].to_numpy(float)
    heur2, heur3, chosen = [], [], []
    for name, tr, te in splits(tasks, split):
        ff = FoldFeatures(view, stats, emb, fset)
        m = M1(kind, seed).fit(ff, tr, S, groups)
        p = m.predict(te)
        for k in ("raw", "isotonic", "platt"):
            preds[k][te] = p[k]
        preds["prior"][te] = S[tr].mean(0)
        cbar[te] = K[tr].mean(0)
        tested[te] = True
        fold_of[te] = name
        tau95[te] = pick_tau(m.oof, S[tr], K[tr])
        chosen.append({"fold": name, "params": m.params, "inner_loss": m.inner_loss, "tau95": float(tau95[te][0]),
                       "n_train": int(len(tr)), "n_test": int(len(te))})
        heur2.append((te, h[tr], h[te]))
    idx = np.where(tested)[0]
    out = dict(scheme=scheme, slice=sl, fset=fset, split=split, kind=kind, seed=seed, folds=chosen)
    if store is not None:
        store.update(dict(idx=idx, preds=preds, S=S, K=K, fold_of=fold_of, tasks=tasks, tau95=tau95, heur=heur2, cbar=cbar))
    out["pooled"] = evaluate_pooled(idx, preds, S, K, tau95, heur2, fold_of, cbar, h)
    return out


def evaluate_pooled(idx, preds, S, K, tau95, heur, fold_of, cbar, h):
    Si, Ki = S[idx], K[idx]
    res = {"n_tasks": int(len(idx))}
    res["m1_raw_utility_rule"] = curve_metrics(utility_points(preds["raw"][idx], Si, Ki, cbar[idx]), Si, Ki)
    res["oracle_lagrangian"] = curve_metrics(utility_points(Si, Si, Ki, Ki), Si, Ki)
    # unfitted score: shorter statement => more likely solved (AUROC only; no fitting involved)
    res["heuristic_len_auroc"] = {t: float(roc_auc_score((Si[:, i] > 0.5).astype(int), -h[idx])) for i, t in enumerate(C.TIERS)}
    for k in ("raw", "isotonic", "platt"):
        res[f"m1_{k}"] = curve_metrics(curve_points(preds[k][idx], Si, Ki), Si, Ki)
        res[f"m1_{k}"]["prob"] = prob_metrics(preds[k][idx], Si, preds["prior"][idx].mean(0))
    fx = fixed_points(Si, Ki)
    res["fixed_tiers"] = {t: {"cost_rel": float(fx[i, 0]), "quality": float(fx[i, 1])} for i, t in enumerate(C.TIERS)}
    res["random_matched_cost_hull"] = curve_metrics(fx, Si, Ki)  # mixtures of fixed tiers == per-tier prior on the curve
    res["oracle_tau_rule"] = curve_metrics(curve_points(Si, Si, Ki), Si, Ki)
    a = np.array([next((t for t in range(3) if s[t] >= 0.5), 2) for s in Si])
    r = np.arange(len(a))
    res["oracle_point"] = {"cost_rel": float(Ki[r, a].sum() / Ki[:, 2].sum()), "quality": float(Si[r, a].mean())}
    # heuristic (per-fold quantiles, pooled assignment)
    for nm, which in (("heuristic_len_2tier", 0), ("heuristic_len_3tier", 1)):
        # hand rule fixed in advance: longer problem statement => harder. Per fold, tasks at or below the
        # training fold's q-quantile of length -> low, the rest -> high (2-tier), or -> mid / high split
        # at the midpoint quantile (3-tier). q is swept; quantiles never see the test fold.
        allpts = []
        for q in np.linspace(0, 1, 41):
            assign = np.empty(len(S), int)
            for te, htr, hte in heur:
                c1 = np.quantile(htr, q) if q > 0 else -np.inf
                if which == 0:
                    assign[te] = np.where(hte <= c1, 0, 2)
                else:
                    c2 = np.quantile(htr, q + (1 - q) / 2)
                    assign[te] = np.where(hte <= c1, 0, np.where(hte <= c2, 1, 2))
            aa = assign[idx]
            allpts.append((Ki[r, aa].sum() / Ki[:, 2].sum(), Si[r, aa].mean()))
        pts = np.array(allpts)
        res[nm] = curve_metrics(pts, Si, Ki)
    # operating point chosen on training folds
    for k in ("raw", "isotonic"):
        a = np.array([policy(preds[k][i : i + 1], tau95[i])[0] for i in idx])
        res[f"m1_{k}_at_tau95_from_train"] = {
            "quality_rel_high": float(Si[r, a].mean() / Si[:, 2].mean()),
            "cost_rel_high": float(Ki[r, a].sum() / Ki[:, 2].sum()),
            "tier_share": {t: float((a == i).mean()) for i, t in enumerate(C.TIERS)},
        }
    res["m1_minus_random_hull_auc"] = res["m1_raw"]["auc_norm"] - res["random_matched_cost_hull"]["auc_norm"]
    return res


def bootstrap(store, n_boot=C.N_BOOT, seed=C.SEED, by="repo"):
    """CIs of the headline numbers. by='repo': resample repositories (cluster bootstrap); by='task': tasks."""
    rng = np.random.default_rng(seed)
    idx, preds, S, K, tasks = store["idx"], store["preds"], store["S"], store["K"], store["tasks"]
    repos = tasks["repo"].to_numpy()[idx]
    ur = np.unique(repos)
    members = {r: np.where(repos == r)[0] for r in ur}
    rows = []
    for _ in range(n_boot):
        if by == "repo":
            pick = np.concatenate([members[r] for r in rng.choice(ur, len(ur))])
        else:
            pick = rng.integers(0, len(idx), len(idx))
        ii = idx[pick]
        Si, Ki = S[ii], K[ii]
        m = curve_metrics(curve_points(preds["raw"][ii], Si, Ki), Si, Ki)
        mi = curve_metrics(curve_points(preds["isotonic"][ii], Si, Ki), Si, Ki)
        rh = curve_metrics(fixed_points(Si, Ki), Si, Ki)
        oc = curve_metrics(utility_points(Si, Si, Ki, Ki), Si, Ki)
        row = {"m1_auc": m["auc_norm"], "m1_iso_auc": mi["auc_norm"], "random_hull_auc": rh["auc_norm"], "oracle_auc": oc["auc_norm"], "oracle_minus_random_hull": oc["auc_norm"] - rh["auc_norm"],
               "m1_minus_random_hull": m["auc_norm"] - rh["auc_norm"], "m1_lift_over_chord": m["auc_lift_over_chord"],
               "m1_saved95": m["cost_saved_at_95"], "m1_saved99": m["cost_saved_at_99"],
               "random_saved95": rh["cost_saved_at_95"], "random_saved99": rh["cost_saved_at_99"]}
        pm = prob_metrics(preds["raw"][ii], Si, preds["prior"][ii].mean(0))
        for t in C.TIERS:
            row[f"auroc_{t}"] = pm[t]["auroc_vs_majority"]
            row[f"bss_{t}"] = pm[t]["brier_skill_vs_prior"]
        rows.append(row)
    df = pd.DataFrame(rows)
    return {c: {"lo": float(np.nanpercentile(df[c], 2.5)), "hi": float(np.nanpercentile(df[c], 97.5)),
                "mean": float(np.nanmean(df[c]))} for c in df.columns}


def per_repo(store):
    idx, preds, S, K, tasks = store["idx"], store["preds"], store["S"], store["K"], store["tasks"]
    out = {}
    repos = tasks["repo"].to_numpy()
    for r in sorted(set(repos[idx])):
        ii = idx[repos[idx] == r]
        Si, Ki = S[ii], K[ii]
        m = curve_metrics(curve_points(preds["raw"][ii], Si, Ki), Si, Ki)
        rh = curve_metrics(fixed_points(Si, Ki), Si, Ki)
        pm = prob_metrics(preds["raw"][ii], Si, preds["prior"][ii].mean(0))
        out[r] = {"n": int(len(ii)), "m1_auc": m["auc_norm"], "random_hull_auc": rh["auc_norm"],
                  "m1_minus_random_hull": m["auc_norm"] - rh["auc_norm"],
                  "bss": {t: pm[t]["brier_skill_vs_prior"] for t in C.TIERS},
                  "auroc": {t: pm[t]["auroc_vs_majority"] for t in C.TIERS}}
    return out


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if np.isnan(o) else round(float(o), 5)
    if isinstance(o, np.integer):
        return int(o)
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="headline run only")
    args = ap.parse_args()
    t0 = time.time()
    results = {"grid": GRID, "base_params": BASE, "seed": C.SEED, "n_boot": C.N_BOOT, "taus": "0..1 step 0.01, plus 1.01"}
    head = {}
    # headline: scheme A, core, all features, joint model, three splits
    for split in ("loro", "time", "gkf4"):
        st = {}
        r = run(split=split, store=st)
        r["bootstrap_repo"] = bootstrap(st, by="repo") if split != "time" else None
        r["bootstrap_task"] = bootstrap(st, by="task")
        if split == "loro":
            r["per_repo"] = per_repo(st)
            head = st
            np.savez(C.RESULTS / "loro_headline_preds.npz", idx=st["idx"], raw=st["preds"]["raw"], iso=st["preds"]["isotonic"],
                     platt=st["preds"]["platt"], prior=st["preds"]["prior"], S=st["S"], K=st["K"], tau95=st["tau95"])
        results[f"headline_{split}"] = r
        print(split, "done", round(time.time() - t0), "s", flush=True)
    if not args.quick:
        abl = {}
        plan = [dict(fset="stats"), dict(fset="stats+tfidf"), dict(kind="per_tier"),
                dict(scheme="B_fixed_1_5"), dict(scheme="C_submission_terciles"),
                dict(scheme="B_fixed_1_5", split="time"), dict(scheme="C_submission_terciles", split="time"),
                dict(sl="full")]
        for kw in plan:
            st = {}
            r = run(**kw, store=st)
            sp = kw.get("split", "loro")
            r["bootstrap_repo"] = bootstrap(st, by="repo", n_boot=300) if sp == "loro" else None
            r["bootstrap_task"] = bootstrap(st, by="task", n_boot=300)
            abl["|".join(f"{k}={v}" for k, v in kw.items())] = r
            print(kw, round(time.time() - t0), flush=True)
        seeds = {}
        for s in (C.SEED + 1, C.SEED + 2):
            r = run(seed=s)
            seeds[str(s)] = {"auc": r["pooled"]["m1_raw"]["auc_norm"], "minus_hull": r["pooled"]["m1_minus_random_hull_auc"],
                             "auroc": {t: r["pooled"]["m1_raw"]["prob"][t]["auroc_vs_majority"] for t in C.TIERS}}
            print("seed", s, round(time.time() - t0), flush=True)
        results["seed_stability"] = seeds
        results["ablations"] = abl
    results["runtime_s"] = round(time.time() - t0)
    (C.RESULTS / ("metrics_quick.json" if args.quick else "metrics.json")).write_text(json.dumps(_clean(results), indent=1))
    print("total", results["runtime_s"], "s")


if __name__ == "__main__":
    main()
