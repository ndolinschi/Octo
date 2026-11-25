"""Stage 6, part 2: M1', the baselines, the gate, and the leak ablation (results/stage6_eval.json).

Splits (fixed before any model was run; fixtures/stage6_protocol.md):
  pooled   5 folds over groups, groups dealt to folds at random within each source (seed config.SEED);
  within   the pooled out-of-fold predictions scored inside one source, against that source's fixed-tier mixture
           (plus M1' trained inside the source only, 5 group folds);
  loso     leave one source out (train on three sources, predict the fourth).
Groups: contest (LiveCodeBench), task (BigCodeBench, CanItEdit), repository (SWE-bench Verified).

Every policy is a set of tier choices per task (operating points). A probability model gives its points by two rules:
the design's tau-rule (cheapest tier with p >= tau, else high) and the Lagrangian rule (argmax p - lambda * relative
price), both swept. Curve area = stage 1's: the upper hull of the points with always-low and always-high, averaged
over cost between them, normalised. Intervals: 1 000 bootstrap replicates over groups, stratified by source; the
choices are fixed, the tasks are resampled.
"""

from __future__ import annotations

import argparse
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

from . import config as C
from . import stage6_data as D
from . import stage6_features as F
from .evaluate import TAUS, upper_hull

warnings.filterwarnings("ignore")

N_FOLDS = 5
N_PCA = 32
LGB = dict(
    objective="cross_entropy",
    n_estimators=300,
    learning_rate=0.03,
    num_leaves=15,
    min_child_samples=20,
    subsample=0.8,
    subsample_freq=1,
    colsample_bytree=0.5,
    reg_lambda=1.0,
    verbose=-1,
    n_jobs=4,
)
LAMBDAS = np.r_[0.0, np.geomspace(1e-3, 1e2, 60)]
LEN_GRID = np.round(np.linspace(0, 1, 21), 2)


# ------------------------------------------------------------------------------------------------ folds
def fold_ids(tasks: pd.DataFrame, k: int = N_FOLDS, seed: int = C.SEED) -> np.ndarray:
    """Fold of each task: the groups of each source are shuffled and dealt round-robin (deterministic)."""
    rng = np.random.default_rng(seed)
    f = np.zeros(len(tasks), int)
    for s in sorted(tasks.source.unique()):
        m = (tasks.source == s).to_numpy()
        g = np.array(sorted(tasks.group[m].unique()))
        g = g[rng.permutation(len(g))]
        # big groups first so a source with few groups (SWE: 12 repositories) is spread evenly by size
        sizes = tasks.group[m].value_counts()
        g = sorted(g, key=lambda x: -sizes[x])
        load = np.zeros(k)
        gf = {}
        for x in g:
            j = int(np.argmin(load))
            gf[x] = j
            load[j] += sizes[x]
        f[m] = [gf[x] for x in tasks.group[m]]
    return f


def folds(tasks: pd.DataFrame, kind: str):
    if kind == "pooled":
        f = fold_ids(tasks)
        for j in range(N_FOLDS):
            yield j, np.where(f != j)[0], np.where(f == j)[0]
    elif kind == "loso":
        for s in C.S6_SOURCES:
            m = (tasks.source == s).to_numpy()
            yield s, np.where(~m)[0], np.where(m)[0]
    elif kind == "within":
        f = fold_ids(tasks)
        for s in C.S6_SOURCES:
            m = (tasks.source == s).to_numpy()
            for j in range(N_FOLDS):
                te = np.where(m & (f == j))[0]
                if len(te):
                    yield f"{s}:{j}", np.where(m & (f != j))[0], te
    else:
        raise ValueError(kind)


# ------------------------------------------------------------------------------------------------ policies -> choices
def prob_choices(P: np.ndarray, Krel: np.ndarray) -> np.ndarray:
    """(n_points, n) tier choices from tau- and lambda-rules."""
    out = []
    for tau in TAUS:
        ok = P >= tau
        out.append(np.where(ok.any(1), ok.argmax(1), 2))
    for lam in LAMBDAS:
        out.append(np.argmax(P - lam * Krel, axis=1))
    return np.unique(np.array(out), axis=0)


def length_choices(loglen: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Unfitted length rank: the shortest q1 share -> low, up to q2 -> mid, the rest -> high (q on a 0.05 grid),
    quantiles over the evaluated tasks `idx`."""
    r = np.zeros(len(loglen))
    r[idx] = (np.argsort(np.argsort(loglen[idx])) + 0.5) / len(idx)
    out = []
    for q1 in LEN_GRID:
        for q2 in LEN_GRID[LEN_GRID >= q1]:
            out.append(np.where(r < q1, 0, np.where(r < q2, 1, 2)))
    return np.array(out)


def fixed_choices(n: int) -> np.ndarray:
    return np.repeat(np.arange(3)[:, None], n, axis=1)


# ------------------------------------------------------------------------------------------------ curve area
def area_from_xy(x: np.ndarray, y: np.ndarray, xl: float, ql: float, qh: float) -> float:
    pts = np.vstack([np.c_[x, y], [[xl, ql], [1.0, qh]]])
    pts = pts[np.isfinite(pts).all(1)]
    h = upper_hull(pts)
    xs = np.linspace(xl, 1.0, 101)
    ys = np.interp(xs, h[:, 0], h[:, 1], left=np.nan)
    ys = np.where(np.isnan(ys), ql, ys)
    return float(np.trapezoid(ys, xs) / (1 - xl)) if xl < 1 else float(qh)


class Curves:
    """Areas of many policies on a task subset, for the sample and for bootstrap replicates (shared weights)."""

    def __init__(self, S, K, idx, groups, src, n_boot=C.N_BOOT, seed=C.SEED):
        self.S, self.K, self.idx = S, K, idx
        rng = np.random.default_rng(seed)
        W = np.zeros((n_boot + 1, len(idx)))
        W[0] = 1.0
        g, s = groups[idx], src[idx]
        for ss in np.unique(s):
            m = np.where(s == ss)[0]
            ug, inv = np.unique(g[m], return_inverse=True)
            for bb in range(1, n_boot + 1):
                cnt = np.bincount(rng.integers(0, len(ug), len(ug)), minlength=len(ug))
                W[bb, m] = cnt[inv]
        self.W = W
        Ks, Ss = K[idx], S[idx]
        self.ch = W @ Ks[:, 2]
        self.wsum = W.sum(1)
        self.fx = np.stack([(W @ Ks[:, t]) / self.ch for t in range(3)], 1), np.stack([(W @ Ss[:, t]) / self.wsum for t in range(3)], 1)

    def areas(self, A: np.ndarray) -> np.ndarray:
        """A: (m, n_all) or (m, len(idx)) choices. Returns areas for the sample [0] and each replicate."""
        A = A[:, self.idx] if A.shape[1] != len(self.idx) else A
        r = np.arange(len(self.idx))
        Kc = self.K[self.idx][r, A]  # (m, n)
        Sc = self.S[self.idx][r, A]
        X = (self.W @ Kc.T) / self.ch[:, None]
        Y = (self.W @ Sc.T) / self.wsum[:, None]
        fxx, fxy = self.fx
        out = np.empty(len(self.W))
        for b in range(len(self.W)):
            out[b] = area_from_xy(np.r_[X[b], fxx[b]], np.r_[Y[b], fxy[b]], fxx[b, 0], fxy[b, 0], fxy[b, 2])
        return out


def ci(v: np.ndarray) -> list[float]:
    return [round(float(v[0]), 4), round(float(np.percentile(v[1:], 2.5)), 4), round(float(np.percentile(v[1:], 97.5)), 4)]


# ------------------------------------------------------------------------------------------------ features + models
class Feats:
    """Text statistics + MiniLM embeddings (PCA fitted on the training fold); optional extra (leak) blocks."""

    def __init__(self, tasks: pd.DataFrame, extra: dict | None = None):
        view = F.delegation_view(tasks)
        self.stats = F.text_stats(view).to_numpy(float)
        self.emb = F.embed(F.texts(view))
        self.extra = extra or {}

    def fit_transform(self, tr, te):
        pca = PCA(n_components=N_PCA, random_state=C.SEED).fit(self.emb[tr])
        blocks_tr, blocks_te = [self.stats[tr], pca.transform(self.emb[tr])], [self.stats[te], pca.transform(self.emb[te])]
        for name, (dense, emb) in self.extra.items():
            if dense is not None:
                blocks_tr.append(dense[tr])
                blocks_te.append(dense[te])
            if emb is not None:
                p2 = PCA(n_components=16, random_state=C.SEED).fit(emb[tr])
                blocks_tr.append(p2.transform(emb[tr]))
                blocks_te.append(p2.transform(emb[te]))
        return np.hstack(blocks_tr), np.hstack(blocks_te)


def lgb_fit_predict(Xtr, Str, Xte, seed=C.SEED):
    P = np.zeros((len(Xte), 3))
    for t in range(3):
        m = lgb.LGBMRegressor(**LGB, random_state=seed).fit(Xtr, Str[:, t])
        P[:, t] = m.predict(Xte, raw_score=False)
    return np.clip(P, 1e-4, 1 - 1e-4)


def m1_predict(feats: Feats, S, groups, tr, te, seed=C.SEED):
    """M1' raw and isotonic-calibrated predictions on `te` (calibrators fitted on inner 3-fold OOF of `tr`)."""
    Xtr, Xte = feats.fit_transform(tr, te)
    raw = lgb_fit_predict(Xtr, S[tr], Xte, seed)
    # inner OOF for calibration
    rng = np.random.default_rng(seed)
    ug = np.unique(groups[tr])
    gf = dict(zip(ug, rng.permutation(len(ug)) % 3))
    inner = np.array([gf[g] for g in groups[tr]])
    oof = np.zeros((len(tr), 3))
    for j in range(3):
        a, b_ = tr[inner != j], tr[inner == j]
        if len(a) == 0 or len(b_) == 0:
            continue
        Xa, Xb = feats.fit_transform(a, b_)
        oof[inner == j] = lgb_fit_predict(Xa, S[a], Xb, seed)
    cal = np.zeros_like(raw)
    for t in range(3):
        iso = IsotonicRegression(y_min=0.001, y_max=0.999, out_of_bounds="clip").fit(oof[:, t], S[tr, t])
        cal[:, t] = iso.predict(raw[:, t])
    return raw, cal


def run_model(kind, tasks, S, fn) -> tuple[np.ndarray, np.ndarray]:
    raw = np.full(S.shape, np.nan)
    cal = np.full(S.shape, np.nan)
    for _, tr, te in folds(tasks, kind):
        r, c = fn(tr, te)
        raw[te], cal[te] = r, c
    return raw, cal


def prior_predict(S, key, tr, te):
    """Per-tier mean soft label of the training tasks with the same key (falls back to the global mean)."""
    glob = S[tr].mean(0)
    df = pd.DataFrame(S[tr], columns=[0, 1, 2]).assign(k=key[tr])
    by = df.groupby("k").mean()
    P = np.array([by.loc[k].to_numpy() if k in by.index else glob for k in key[te]])
    return P, P


def logistic_predict(Xall, S, tr, te):
    P = np.zeros((len(te), 3))
    for t in range(3):
        y = S[tr, t]
        # soft labels: duplicate rows with weights y and 1 - y
        X2 = np.vstack([Xall[tr], Xall[tr]])
        y2 = np.r_[np.ones(len(tr)), np.zeros(len(tr))]
        w2 = np.r_[y, 1 - y] + 1e-6
        m = LogisticRegression(C=1.0, max_iter=1000).fit(X2, y2, sample_weight=w2)
        P[:, t] = m.predict_proba(Xall[te])[:, 1]
    return P, P


# ------------------------------------------------------------------------------------------------ probability metrics
def prob_metrics(P, S, idx, prior):
    out = {}
    for t, name in enumerate(D.TIERS):
        p, s = P[idx, t], S[idx, t]
        y = (s >= 0.5).astype(int)
        bs = np.mean((p - s) ** 2)
        b0 = np.mean((prior[idx, t] - s) ** 2)
        e = np.minimum((p * 10).astype(int), 9)
        ece = sum(abs(p[e == k].mean() - s[e == k].mean()) * (e == k).mean() for k in range(10) if (e == k).any())
        out[name] = {
            "auroc_vs_majority": round(float(roc_auc_score(y, p)), 3) if 0 < y.mean() < 1 else None,
            "spearman": round(float(pd.Series(p).corr(pd.Series(s), method="spearman")), 3),
            "brier_skill_vs_prior": round(float(1 - bs / b0), 3) if b0 > 0 else None,
            "ece": round(float(ece), 3),
        }
    return out


# ------------------------------------------------------------------------------------------------ main evaluation
def evaluate(n_boot: int = C.N_BOOT, scheme: str = "A", leak: bool = True, tokens: str = "assumed") -> dict:
    t0 = time.time()
    b = D.build()
    if tokens == "equal":  # sensitivity: every task costs its tier's price x the same number of tokens
        b["tokens"] = {k: 10_000 for k in b["tokens"]}
    tasks = b["tasks"]
    S, K = D.labels(b, scheme)
    Krel = K / K[:, 2:3]
    src = tasks.source.to_numpy()
    groups = tasks.group.to_numpy()
    n = len(tasks)
    view = F.delegation_view(tasks)
    stats = F.text_stats(view)
    loglen = stats["log_chars"].to_numpy()
    feats = Feats(tasks)
    rule = np.array([F.router_rule_band(x) for x in F.texts(view)])

    preds: dict[str, dict[str, np.ndarray]] = {}  # kind -> name -> P (calibrated where it applies)
    raw_store = {}
    for kind in ("pooled", "loso"):
        print(f"[{time.time() - t0:.0f}s] {kind}: M1'", flush=True)
        raw, cal = run_model(kind, tasks, S, lambda tr, te: m1_predict(feats, S, groups, tr, te))
        preds.setdefault(kind, {})["M1'"] = cal
        raw_store[(kind, "M1'")] = raw
        preds[kind]["prior (global)"] = run_model(kind, tasks, S, lambda tr, te: prior_predict(S, np.zeros(n), tr, te))[0]
        preds[kind]["length-only (fitted)"] = run_model(kind, tasks, S, lambda tr, te: logistic_predict(loglen[:, None], S, tr, te))[0]
        if kind == "pooled":
            preds[kind]["source-id prior"] = run_model(kind, tasks, S, lambda tr, te: prior_predict(S, src, tr, te))[0]
            oh = pd.get_dummies(src).to_numpy(float)
            preds[kind]["source-id + length (fitted)"] = run_model(kind, tasks, S, lambda tr, te: logistic_predict(np.c_[oh, loglen, oh * loglen[:, None]], S, tr, te))[0]
        for f in ("pooled", "loso"):
            m2 = C.S6_DATA / f"m2_oof_{f}.npz"
            if f == kind and m2.exists() and scheme == "A":  # M2' was trained on scheme-A labels only
                z = np.load(m2, allow_pickle=True)
                assert (z["uid"] == tasks.uid.to_numpy()).all()
                preds[kind]["M2'"] = z["cal"]
                raw_store[(kind, "M2'")] = z["raw"]
    print(f"[{time.time() - t0:.0f}s] within: M1' trained inside each source", flush=True)
    raw, cal = run_model("within", tasks, S, lambda tr, te: m1_predict(feats, S, groups, tr, te))
    within_only = cal
    # human difficulty tags (NOT available at routing time): per-tier mean of training tasks with the same tag
    tag = tasks.leak_difficulty.fillna("none").astype(str).to_numpy()
    tag_key = np.array([f"{s}:{x}" for s, x in zip(src, tag)])
    tag_pred = run_model("pooled", tasks, S, lambda tr, te: prior_predict(S, tag_key, tr, te))[0]

    def choice_sets(P, idx):
        return {"probs": prob_choices(P, Krel)}

    def baseline_sets(idx):
        return {
            "fixed-tier mixture": fixed_choices(n),
            "length rank (unfitted)": length_choices(loglen, idx),
            "router text rule": np.vstack([rule[None, :], fixed_choices(n)]),
        }

    out = {"scheme": scheme, "tokens_mode": tokens, "n_boot": n_boot, "n_tasks": n, "tokens_per_task": {k: round(v) for k, v in b["tokens"].items()}}
    oracle = prob_choices(S, Krel)

    def block(kind, idx, extra_P: dict, label: str) -> dict:
        cur = Curves(S, K, idx, groups, src, n_boot)
        res = {"n": int(len(idx))}
        areas = {}
        for name, A in baseline_sets(idx).items():
            areas[name] = cur.areas(A)
        for name, P in extra_P.items():
            areas[name] = cur.areas(prob_choices(P, Krel))
        areas["oracle (true soft labels; optimistic)"] = cur.areas(oracle)
        base_names = ["fixed-tier mixture", "length rank (unfitted)", "router text rule"]
        best = max(base_names, key=lambda k: areas[k][0])
        res["area"] = {k: ci(v) for k, v in areas.items()}
        res["best_non_learned_baseline"] = best
        res["gain_over_mixture"] = {k: ci(v - areas["fixed-tier mixture"]) for k, v in areas.items() if k != "fixed-tier mixture"}
        res["gain_over_best_baseline"] = {k: ci(v - areas[best]) for k, v in areas.items() if k not in base_names}
        print(f"[{time.time() - t0:.0f}s] {label}: " + ", ".join(f"{k}={v[0]:.4f}" for k, v in areas.items()), flush=True)
        return res

    allidx = np.arange(n)
    for kind in ("pooled", "loso"):
        P = preds[kind]
        out[kind] = {"all": block(kind, allidx, P, f"{kind}/all")}
        out[kind]["per_source"] = {}
        for s in C.S6_SOURCES:
            idx = np.where(src == s)[0]
            extra = dict(P)
            if kind == "pooled":
                extra["M1' trained within the source only"] = within_only
                if s in ("livecodebench", "swebench_verified"):
                    extra["human difficulty tag (NOT available at routing time)"] = tag_pred
            out[kind]["per_source"][s] = block(kind, idx, extra, f"{kind}/{s}")
        prior = preds[kind]["prior (global)"]
        out[kind]["prob_metrics"] = {
            name: {s: prob_metrics(Pm, S, np.where(src == s)[0], prior) for s in C.S6_SOURCES} | {"all": prob_metrics(Pm, S, allidx, prior)}
            for name, Pm in P.items()
            if name in ("M1'", "M2'", "length-only (fitted)", "source-id prior")
        }
        out[kind]["ece_raw"] = {
            name: {t: prob_metrics(raw_store[(kind, name)], S, allidx, prior)[t]["ece"] for t in D.TIERS} for (k2, name) in raw_store if k2 == kind
        }
        # cheapest sufficient tier: predicted (p >= 0.5) against the label
        lab = D.cheapest_sufficient(S)
        out[kind]["cheapest_sufficient_accuracy"] = {
            name: {
                s: round(float(np.mean(D.cheapest_sufficient(Pm[src == s]) == lab[src == s])), 3) for s in C.S6_SOURCES
            }
            | {"all": round(float(np.mean(D.cheapest_sufficient(Pm) == lab)), 3)}
            for name, Pm in P.items()
        }
        out[kind]["cheapest_sufficient_majority_class"] = {
            s: round(float(np.bincount(lab[src == s], minlength=4).max() / (src == s).sum()), 3) for s in C.S6_SOURCES
        }
    out["gate"] = gate(out)
    if leak:
        out["leak_ablation"] = leak_ablation(tasks, S, K, Krel, groups, src, n_boot=min(n_boot, 300))
    out["seconds"] = round(time.time() - t0)
    if scheme == "A" and tokens == "assumed":
        np.savez(C.S6_DATA / "stage6_preds.npz", uid=tasks.uid.to_numpy(), **{f"{k}|{nm}": v for k, d in preds.items() for nm, v in d.items()})
    return out


def gate(out: dict) -> dict:
    """The pre-declared gate (fixtures/stage6_protocol.md)."""
    res = {}
    for model in ("M1'", "M2'"):
        lo = out["loso"]["all"]
        if model not in lo["gain_over_best_baseline"]:
            continue
        g = lo["gain_over_best_baseline"][model]
        within = {s: out["pooled"]["per_source"][s]["gain_over_mixture"][model][0] for s in C.S6_SOURCES}
        pos = sum(v > 0 for v in within.values())
        c1 = g[1] > 0
        c2 = pos > len(within) / 2
        res[model] = {
            "loso_gain_over_best_non_learned": g,
            "best_non_learned_baseline": lo["best_non_learned_baseline"],
            "condition_1_loso_interval_above_0": bool(c1),
            "within_source_gain_over_mixture": within,
            "sources_with_positive_gain": f"{pos} of {len(within)}",
            "condition_2_majority_positive": bool(c2),
            "verdict": "supported for delegation routing" if (c1 and c2) else "not supported",
        }
    return res


# ------------------------------------------------------------------------------------------------ leak ablation
def leak_ablation(tasks, S, K, Krel, groups, src, n_boot=300) -> dict:
    """M1' with one leaky field added at a time, as its own feature block (text -> length + embedding PCA(16);
    categorical -> one-hot). How much 'accuracy' each field would add if it were (wrongly) used."""

    def txt_block(col):
        x = tasks[col].fillna("").astype(str).tolist()
        return np.log1p(np.array([len(v) for v in x]))[:, None], F.embed([v if v else "(none)" for v in x])

    def cat_block(col):
        return pd.get_dummies(tasks[col].fillna("none").astype(str)).to_numpy(float), None

    variants = {
        "none (the final feature set)": {},
        "+ human difficulty tag (LiveCodeBench, SWE-bench)": {"tag": cat_block("leak_difficulty")},
        "+ constraints / follow-up section (LiveCodeBench)": {"cons": txt_block("leak_constraints")},
        "+ starter code / file to edit (LCB, BCB, CanItEdit)": {"starter": txt_block("leak_starter")},
        "+ platform (LiveCodeBench)": {"platform": cat_block("leak_platform")},
        "+ reference solution (BCB, CanItEdit, SWE patch)": {"sol": txt_block("leak_solution")},
        "+ test code (BCB, CanItEdit, SWE test patch)": {"tests": txt_block("leak_tests")},
        "+ source id": {"source": (pd.get_dummies(tasks.source).to_numpy(float), None)},
    }
    variants["+ all of the above"] = {k: v for d in list(variants.values())[1:] for k, v in d.items()}
    n = len(tasks)
    cur_all = Curves(S, K, np.arange(n), groups, src, n_boot)
    cur_src = {s: Curves(S, K, np.where(src == s)[0], groups, src, n_boot) for s in C.S6_SOURCES}
    out = {}
    for name, extra in variants.items():
        feats = Feats(tasks, extra)
        res = {}
        for kind in ("pooled", "loso"):
            _, cal = run_model(kind, tasks, S, lambda tr, te: m1_predict(feats, S, groups, tr, te))
            A = prob_choices(cal, Krel)
            mix_all = cur_all.areas(fixed_choices(n))
            a_all = cur_all.areas(A)
            r = {"area_all": ci(a_all), "gain_over_mixture_all": ci(a_all - mix_all), "within_gain_over_mixture": {}, "within_auroc_low": {}}
            for s in C.S6_SOURCES:
                idx = np.where(src == s)[0]
                g = cur_src[s].areas(A) - cur_src[s].areas(fixed_choices(n))
                r["within_gain_over_mixture"][s] = ci(g)
                y = (S[idx, 0] >= 0.5).astype(int)
                r["within_auroc_low"][s] = round(float(roc_auc_score(y, cal[idx, 0])), 3) if 0 < y.mean() < 1 else None
            res[kind] = r
        out[name] = res
        print(f"  leak {name}: pooled {res['pooled']['gain_over_mixture_all']}, loso {res['loso']['gain_over_mixture_all']}", flush=True)
    return out


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-boot", type=int, default=C.N_BOOT)
    ap.add_argument("--scheme", default="A")
    ap.add_argument("--no-leak", action="store_true")
    ap.add_argument("--tokens", default="assumed", choices=("assumed", "equal"))
    a = ap.parse_args()
    res = evaluate(a.n_boot, a.scheme, leak=not a.no_leak, tokens=a.tokens)
    name = "stage6_eval" + ("" if a.scheme == "A" else f"_{a.scheme}") + ("" if a.tokens == "assumed" else "_equal_tokens") + ".json"
    (C.RESULTS / name).write_text(json.dumps(_clean(res), indent=1))
    print(json.dumps(_clean(res["gate"]), indent=1))


if __name__ == "__main__":
    main()
