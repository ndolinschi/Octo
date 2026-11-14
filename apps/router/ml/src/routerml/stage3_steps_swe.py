"""Stage 3, check 3 (SWE-bench only): the same protocol as stage3_steps restricted to TwinRouterBench's 336 SWE
steps (40 trajectories), the workload this thesis is about. Leave-one-trajectory-out; the "prior" is the training
fold's label distribution (= the workload prior inside one workload); the benchmark's v2 metric on SWE rows only;
intervals: 1000 bootstraps over the 40 trajectories. Four tiers and three (low+mid merged)."""

from __future__ import annotations

import numpy as np

from . import config as C
from .stage2 import ci, save
from .stage3_steps import (RATES, TIERS4, Scorer, agg, at_rate, features, load_rows, model_frontier, oof,
                           trivial_frontier, with_ci)


def main():
    rows = [r for r in load_rows() if r["benchmark"] == "swebench"]
    X, T, W = features(rows)
    gold4 = np.array([r["target_tier_id"] for r in rows])
    sc = Scorer(rows)
    rng = np.random.default_rng(C.SEED + 500)
    tb = sc.tbench
    boots = [rng.choice(len(tb), len(tb)) for _ in range(1000)]
    res = {"method": __doc__, "n_rows": len(rows), "n_trajectories": len(tb)}
    for nt in (4, 3):
        ids = np.arange(4) if nt == 4 else np.array([1, 2, 3])
        gold = gold4 if nt == 4 else np.maximum(gold4, 1)
        y = np.searchsorted(ids, gold)
        r = {}
        for t in ids:
            s, tab = sc.score(np.full(len(gold), t), gold, check=True)
            r[f"always_{TIERS4[t]}"] = {"point": s, "ci": with_ci(tab, tb, boots)}
        s, tab = sc.score(gold, gold, check=True)
        r["oracle"] = {"point": s, "ci": with_ci(tab, tb, boots)}
        P, maj = oof(rows, X, T, W, y, "loto", len(ids), "model")
        Pp, _ = oof(rows, X, T, W, y, "loto", len(ids), "workload_prior")
        r["log_loss_model"] = float(-np.mean(np.log(np.clip(P[np.arange(len(y)), y], 1e-6, 1))))
        r["log_loss_prior"] = float(-np.mean(np.log(np.clip(Pp[np.arange(len(y)), y], 1e-6, 1))))
        r["accuracy_model"] = float((P.argmax(1) == y).mean())
        r["accuracy_prior"] = float((Pp.argmax(1) == y).mean())
        s, tab = sc.score(ids[P.argmax(1)], gold, check=True)
        r["model_argmax"] = {"point": s, "ci": with_ci(tab, tb, boots)}
        mf = model_frontier(sc, P, gold, ids)
        pf = model_frontier(sc, Pp, gold, ids)
        tf_ = trivial_frontier(sc, gold, ids, ids[np.bincount(y).argmax()], rng)
        r["model_frontier"] = [{"q": q, **s} for q, s, _ in mf]
        r["prior_frontier"] = [{"q": q, **s} for q, s, _ in pf]
        r["trivial_frontier"] = [{"p_majority": p, **s} for p, s, _ in tf_]
        fr = {}
        for rate in RATES:
            e = {}
            for name, front in (("model", mf), ("prior", pf), ("trivial", tf_)):
                pt = at_rate(front, rate)
                e[name] = None if pt is None else {"setting": pt[0], "point": pt[1], "ci": with_ci(pt[2], tb, boots)}
            for base in ("prior", "trivial"):
                if e["model"] and e[base]:
                    a, b = at_rate(mf, rate)[2], at_rate(pf if base == "prior" else tf_, rate)[2]
                    e[f"model_minus_{base}_raw_cost_saved_ci"] = ci([agg(a, tb, i)["raw_cost_saved_percent"] - agg(b, tb, i)["raw_cost_saved_percent"] for i in boots])
            fr[f"under_{rate}"] = e
        r["at_fixed_under_routing"] = fr
        res[f"tiers_{nt}"] = r
        print(nt, flush=True)
    save("stage3_steps_swe.json", res)


if __name__ == "__main__":
    main()
