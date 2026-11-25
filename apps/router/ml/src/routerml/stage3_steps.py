"""Stage 3, check 3: step-level routing on TwinRouterBench as a cost-quality result, scored with the benchmark's own code.

Data: the whole static question bank (970 steps, 520 trajectories, 5 workloads), its four tiers (low, mid, mid_high,
high), its price table (main/pricing.py) and its scoring (main/eval/section11.compute_v2_scores: case pass,
exact match, trajectory pass, cost-savings score with a failed trajectory charged its routed chain plus one
always-high re-run). The benchmark's own code is imported from the pinned checkout in data/twinrouterbench; its
tokenizers are the real ones it names (DeepSeek-V3, MiniMax-Text-01, cl100k, its Anthropic JSON); token counts are
memoised per (tier, text) only for speed.
Three-tier variant: low and mid merged into one tier that must serve gold-mid steps, i.e. gold' = max(gold, mid),
predictions in {mid, mid_high, high}.
Policies: always each tier; the training fold's majority tier; the oracle (gold); a step-time model (multinomial
logistic regression, C = 1 declared up front: stage 2's numeric step features + last role + tool-schema size +
TF-IDF of the last message, fitted inside each fold; with the workload one-hot only in leave-one-trajectory-out,
since it cannot transfer to an unseen workload); a workload prior (training fold's label distribution within the
step's workload, no step features). Protocols: leave-one-trajectory-out (520 folds) and leave-one-workload-out (5).
Thresholding: pred = the cheapest tier t with P(gold <= t) >= q, swept over q; the trivial policy at the same
under-routing rate routes a random share of steps to the majority tier and the rest to high (5 draws averaged).
Fixed under-routing rate r: the cheapest point of each frontier with step-level under-routing <= r (selected on the
pooled out-of-fold predictions: a frontier comparison, not an operating point chosen out of sample).
Intervals: 1000 bootstraps over trajectories, stratified by workload.
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict

import numpy as np
from scipy.sparse import csr_matrix, hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

from . import config as C
from .stage2 import ci, save
from .steps import QB, step_features

TRB = C.DATA / "twinrouterbench"
TIERS4 = ("low", "mid", "mid_high", "high")
WORKLOADS = ("swebench", "pinchbench", "mtrag", "qmsum", "bfcl")
C_LR = 1.0
N_BOOT = 1000
RATES = (0.01, 0.05, 0.10)
QS = np.r_[np.linspace(0.05, 0.95, 19), 0.97, 0.98, 0.99, 0.995, 0.999, 0.9999]


def _bench():
    if str(TRB) not in sys.path:
        sys.path.insert(0, str(TRB))
    import main.tokenizer as tok
    from main.eval import section11 as s11

    if not getattr(tok, "_memo_patched", False):
        orig = tok._load_tier_encoder

        class Memo:
            def __init__(self, enc):
                self.enc, self.cache = enc, {}

            def count(self, text):
                v = self.cache.get(text)
                if v is None:
                    v = self.cache[text] = self.enc.count(text)
                return v

        memo = {}

        def load(tier):
            if tier not in memo:
                memo[tier] = Memo(orig(tier))
            return memo[tier]

        tok._load_tier_encoder = load
        tok._memo_patched = True
    return s11


def load_rows():
    return [json.loads(l) for l in QB.open()]


def features(rows):
    X, T = [], []
    for r in rows:
        x, t = step_features(r["messages"], r["step_index"])
        last = r["messages"][-1]
        extra = [float(last.get("role") == k) for k in ("user", "tool", "assistant")]
        extra.append(np.log1p(len(json.dumps(r.get("functions") or []))))
        extra.append(float(isinstance(last.get("content"), list)))
        X.append(np.r_[x, extra])
        T.append(t[-4000:])
    W = np.array([[float(r["benchmark"] == w) for w in WORKLOADS] for r in rows])
    return np.array(X), T, W


def fit_predict(X, T, W, y, tr, te, use_workload, n_class, seed=C.SEED):
    Xa = np.hstack([X, W]) if use_workload else X
    mu, sd = Xa[tr].mean(0), Xa[tr].std(0) + 1e-9
    A, B = (Xa[tr] - mu) / sd, (Xa[te] - mu) / sd
    tf = TfidfVectorizer(max_features=2000, ngram_range=(1, 2), min_df=2, sublinear_tf=True)
    ta = tf.fit_transform([T[i] for i in tr])
    tb = tf.transform([T[i] for i in te])
    A, B = hstack([csr_matrix(A), ta]).tocsr(), hstack([csr_matrix(B), tb]).tocsr()
    p = np.zeros((len(te), n_class))
    cls = np.unique(y[tr])
    if len(cls) == 1:
        p[:, cls[0]] = 1
        return p
    lr = LogisticRegression(C=C_LR, max_iter=3000, random_state=seed).fit(A, y[tr])
    p[:, lr.classes_] = lr.predict_proba(B)
    return p


def oof(rows, X, T, W, y, protocol, n_class, kind):
    traj = np.array([r["benchmark"] + "/" + r["instance_id"] for r in rows])
    bench = np.array([r["benchmark"] for r in rows])
    groups = traj if protocol == "loto" else bench
    P = np.zeros((len(y), n_class))
    maj = np.zeros(len(y), int)
    for gname in np.unique(groups):
        te = np.where(groups == gname)[0]
        tr = np.where(groups != gname)[0]
        maj[te] = np.bincount(y[tr], minlength=n_class).argmax()
        if kind == "model":
            P[te] = fit_predict(X, T, W, y, tr, te, protocol == "loto", n_class)
        elif kind == "workload_prior":
            for b in np.unique(bench[te]):
                trb = tr[bench[tr] == b]
                src = trb if len(trb) else tr
                P[te[bench[te] == b]] = np.bincount(y[src], minlength=n_class) / len(src)
    return P, maj


def threshold(P, q):
    cum = np.cumsum(P, 1)
    ok = cum >= q - 1e-12
    return np.where(ok.any(1), ok.argmax(1), P.shape[1] - 1)


class Scorer:
    """The benchmark's own v2 metric, plus a per-trajectory decomposition for bootstrapping."""

    def __init__(self, rows):
        self.s11 = _bench()
        self.rows = rows
        self.traj = [r["benchmark"] + "/" + r["instance_id"] for r in rows]
        self.utraj = sorted(set(self.traj))
        self.tidx = {t: i for i, t in enumerate(self.utraj)}
        self.tbench = np.array([t.split("/")[0] for t in self.utraj])

    def recs(self, pred, gold):
        out = []
        for r, p, g in zip(self.rows, pred, gold):
            d = {k: r[k] for k in ("id", "benchmark", "step_index", "messages")}
            d["instance_id"] = r["benchmark"] + "/" + r["instance_id"]
            d["pred_tier_id"], d["gold_tier_id"] = int(p), int(g)
            out.append(d)
        return out

    def score(self, pred, gold, check=False):
        recs = self.recs(pred, gold)
        n = len(self.utraj)
        tab = {k: np.zeros(n) for k in ("rows", "case_pass", "exact", "passed", "D", "N", "pred_cost")}
        for r, p, g in zip(recs, pred, gold):
            i = self.tidx[r["instance_id"]]
            tab["rows"][i] += 1
            tab["case_pass"][i] += p >= g
            tab["exact"][i] += p == g
        for rec in self.s11._iter_trajectory_step_costs(recs):
            i = self.tidx[rec["instance_id"]]
            tab["passed"][i] = rec["trajectory_passed"]
            tab["D"][i] += rec["baseline_cost"]
            tab["pred_cost"][i] += rec["pred_cost"]
            tab["N"][i] += rec["baseline_cost"] - rec["pred_cost"] if rec["trajectory_passed"] else -rec["pred_cost"]
        out = agg(tab, self.tbench, np.arange(n))
        out["under_routing_rate"] = float((np.asarray(pred) < np.asarray(gold)).mean())
        if check:
            v2 = self.s11.compute_v2_scores(recs)
            for k in ("case_pass_rate_percent", "case_exact_match_percent", "trajectory_pass_rate_percent", "cost_savings_score_percent"):
                assert abs(v2[k] - out[k]) < 1e-6, (k, v2[k], out[k])
            out["benchmark_v2_combined_score_percent"] = v2["combined_score_percent"]
        return out, tab


def agg(tab, tbench, idx):
    rows = tab["rows"][idx].sum()
    res = {"case_pass_rate_percent": 100 * tab["case_pass"][idx].sum() / rows,
           "case_exact_match_percent": 100 * tab["exact"][idx].sum() / rows,
           "trajectory_pass_rate_percent": 100 * (tab["rows"][idx] * tab["passed"][idx]).sum() / rows}
    cs = 0.0
    for b in WORKLOADS:
        m = idx[tbench[idx] == b]
        if len(m) == 0:
            continue
        w = tab["rows"][m].sum() / rows
        D = tab["D"][m].sum()
        if D > 0:
            cs += w * 100 * tab["N"][m].sum() / D
    res["cost_savings_score_percent"] = cs
    res["combined_score_percent"] = float(np.mean(list(res.values())))
    res["raw_cost_saved_percent"] = 100 * (1 - tab["pred_cost"][idx].sum() / tab["D"][idx].sum())
    return res


def boot_idx(tbench, rng):
    out = []
    strata = [np.where(tbench == b)[0] for b in WORKLOADS]
    for _ in range(N_BOOT):
        out.append(np.concatenate([rng.choice(s, len(s)) for s in strata]))
    return out


def with_ci(tab, tbench, boots, keys=("cost_savings_score_percent", "trajectory_pass_rate_percent", "raw_cost_saved_percent", "combined_score_percent")):
    bs = [agg(tab, tbench, b) for b in boots]
    return {k: ci([b[k] for b in bs]) for k in keys}


def model_frontier(scorer, P, gold, ids):
    out = []
    for q in QS:
        s, tab = scorer.score(ids[threshold(P, q)], gold)
        out.append((q, s, tab))
    return out


def trivial_frontier(scorer, gold, ids, maj_id, rng, n_draw=5):
    """Random share p of steps to the majority tier, the rest to high; expected over n_draw draws."""
    out = []
    n = len(gold)
    for p_low in np.linspace(0, 1, 21):
        draws = [scorer.score(np.where(rng.random(n) < p_low, maj_id, ids[-1]), gold) for _ in range(n_draw)]
        s = {k: float(np.mean([d[0][k] for d in draws])) for k in draws[0][0]}
        tab = {k: np.mean([d[1][k] for d in draws], 0) for k in draws[0][1]}
        out.append((p_low, s, tab))
    return out


def at_rate(front, r):
    ok = [f for f in front if f[1]["under_routing_rate"] <= r + 1e-12]
    return max(ok, key=lambda f: f[1]["raw_cost_saved_percent"]) if ok else None


def run_variant(rows, X, T, W, gold4, n_tiers, scorer, boots, rng):
    if n_tiers == 4:
        ids = np.arange(4)
        gold = gold4
    else:
        ids = np.array([1, 2, 3])
        gold = np.maximum(gold4, 1)
    y = np.searchsorted(ids, gold)
    res = {}
    fixed = {}
    for k, t in enumerate(ids):
        s, tab = scorer.score(np.full(len(gold), t), gold, check=True)
        fixed[f"always_{TIERS4[t]}"] = {"point": s, "ci": with_ci(tab, scorer.tbench, boots)}
    s, tab = scorer.score(gold, gold, check=True)
    fixed["oracle"] = {"point": s, "ci": with_ci(tab, scorer.tbench, boots)}
    res["fixed_and_oracle"] = fixed
    for protocol in ("loto", "lowo"):
        t0 = time.time()
        P, maj = oof(rows, X, T, W, y, protocol, len(ids), "model")
        Pw, _ = oof(rows, X, T, W, y, protocol, len(ids), "workload_prior")
        r = {}
        s, tab = scorer.score(ids[maj], gold, check=True)
        r["majority"] = {"point": s, "ci": with_ci(tab, scorer.tbench, boots)}
        for name, PP in (("model", P), ("workload_prior", Pw)):
            pred = ids[PP.argmax(1)]
            s, tab = scorer.score(pred, gold, check=True)
            r[f"{name}_argmax"] = {"point": s, "ci": with_ci(tab, scorer.tbench, boots),
                                   "accuracy": float((PP.argmax(1) == y).mean())}
        r["model_log_loss"] = float(-np.mean(np.log(np.clip(P[np.arange(len(y)), y], 1e-6, 1))))
        r["workload_prior_log_loss"] = float(-np.mean(np.log(np.clip(Pw[np.arange(len(y)), y], 1e-6, 1))))
        maj_id = ids[np.bincount(y).argmax()]
        mf = model_frontier(scorer, P, gold, ids)
        tf_ = trivial_frontier(scorer, gold, ids, maj_id, rng)
        wf = model_frontier(scorer, Pw, gold, ids) if protocol == "loto" else None
        r["model_frontier"] = [{"q": q, **s} for q, s, _ in mf]
        r["trivial_frontier"] = [{"p_majority": p, **s} for p, s, _ in tf_]
        if wf:
            r["workload_prior_frontier"] = [{"q": q, **s} for q, s, _ in wf]
        fr = {}
        for rate in RATES:
            e = {}
            for name, front in (("model", mf), ("trivial", tf_), ("workload_prior", wf)):
                if not front:
                    continue
                pt = at_rate(front, rate)
                if pt is None:
                    e[name] = None
                    continue
                e[name] = {"setting": pt[0], "point": pt[1], "ci": with_ci(pt[2], scorer.tbench, boots)}
            if e.get("model") and e.get("trivial"):
                bm = [agg(at_rate(mf, rate)[2], scorer.tbench, b)["raw_cost_saved_percent"] - agg(at_rate(tf_, rate)[2], scorer.tbench, b)["raw_cost_saved_percent"] for b in boots[:300]]
                e["model_minus_trivial_raw_cost_saved_ci"] = ci(bm)
            fr[f"under_{rate}"] = e
        r["at_fixed_under_routing"] = fr
        r["runtime_s"] = round(time.time() - t0)
        res[protocol] = r
        print(n_tiers, protocol, r["runtime_s"], "s", flush=True)
    return res


def main():
    rows = load_rows()
    X, T, W = features(rows)
    gold4 = np.array([r["target_tier_id"] for r in rows])
    scorer = Scorer(rows)
    rng = np.random.default_rng(C.SEED + 300)
    boots = boot_idx(scorer.tbench, rng)
    res = {"method": __doc__, "n_rows": len(rows), "n_trajectories": len(scorer.utraj),
           "workloads": {b: {"rows": int(sum(r["benchmark"] == b for r in rows)),
                             "trajectories": int((scorer.tbench == b).sum()),
                             "gold": {t: int(sum(r["benchmark"] == b and r["target_tier"] == t for r in rows)) for t in TIERS4},
                             "pipeline_stage": sorted({r["pipeline_stage"] for r in rows if r["benchmark"] == b})} for b in WORKLOADS}}
    for nt in (4, 3):
        res[f"tiers_{nt}"] = run_variant(rows, X, T, W, gold4, nt, scorer, boots, rng)
        save("stage3_steps.json", res)


if __name__ == "__main__":
    main()
