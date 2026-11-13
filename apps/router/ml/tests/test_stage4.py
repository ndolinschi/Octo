"""Stage 4 guards: bandit feedback isolation (L1), first-request-only features (L2), no future outcomes (L3)."""

from __future__ import annotations

import copy
import json

import numpy as np
import pytest

from routerml import stage4_controller as L3
from routerml import stage4_ladder as L1
from routerml.stage4_common import Arms


def toy_arms(K=6, n=80, seed=0):
    rng = np.random.default_rng(seed)
    p = rng.uniform(0.2, 0.8, K)
    R = (rng.random((K, n)) < p[:, None]).astype(float)
    Kc = rng.gamma(2.0, 0.05, (K, n)) * (1 + np.arange(K))[:, None]
    import pandas as pd

    tasks = pd.DataFrame({"repo": ["r"] * n, "created_at": pd.date_range("2020", periods=n).astype(str)})
    return Arms([f"m{j}" for j in range(K)], [f"s{j}" for j in range(K)], np.arange(K) % 3, 0.5 + np.arange(K),
                R.mean(1), R, Kc, tasks)


@pytest.mark.parametrize("make", [
    lambda A, ns, T: L1.TS(A, ns, T, 1.0, np.random.default_rng(5), prior="flat"),
    lambda A, ns, T: L1.TS(A, ns, T, 1.0, np.random.default_rng(5), prior="band"),
    lambda A, ns, T: L1.TS(A, ns, T, 0.0, np.random.default_rng(5), q=0.9, prior="flat"),
    lambda A, ns, T: L1.TS(A, ns, T, 1.0, np.random.default_rng(5), window=10),
    lambda A, ns, T: L1.UCB(A, ns, T, 1.0, np.random.default_rng(5)),
    lambda A, ns, T: L1.SuccElim(A, ns, T, 1.0, np.random.default_rng(5)),
    lambda A, ns, T: L1.EpsGreedy(A, ns, T, 1.0, np.random.default_rng(5)),
])
def test_l1_bandit_sees_only_chosen_cells(make):
    """Flip the outcome and cost of every (model, task) cell no stream chose: decisions must not change."""
    A = toy_arms()
    K, n = A.R.shape
    ns = 4
    orders = np.array([np.random.default_rng(s).permutation(n) for s in range(ns)])
    av = np.ones((ns, K), bool)
    arms1, _ = L1.simulate(make(A, ns, n), L1.Env(A.R, A.Kc, orders), n, lambda t: av)
    chosen = np.zeros_like(A.R, bool)
    chosen[arms1, orders] = True
    R2 = np.where(chosen, A.R, 1 - A.R)
    K2 = np.where(chosen, A.Kc, A.Kc * 7 + 3)
    A2 = copy.copy(A)
    A2.R, A2.Kc = R2, K2
    arms2, _ = L1.simulate(make(A2, ns, n), L1.Env(R2, K2, orders), n, lambda t: av)
    assert (arms1 == arms2).all()
    assert (~chosen).sum() > 0


def test_l1_env_returns_only_chosen_and_degrades_after_t0():
    A = toy_arms()
    orders = np.tile(np.arange(A.R.shape[1]), (2, 1))
    env = L1.Env(A.R, A.Kc, orders, degrade=(0, 1, 10))
    y, c = env.pull(3, np.array([0, 2]))
    assert y.shape == (2,) and c.shape == (2,)
    assert y[0] == A.R[0, 3]
    y, _ = env.pull(12, np.array([0, 0]))
    assert (y == A.R[1, 12]).all()


def test_l3_controller_never_reads_future_outcomes():
    """Change every outcome at stream positions >= t0: decisions up to and including t0 must be identical."""
    rng = np.random.default_rng(1)
    K, n, ns, M = 3, 60, 5, 20
    S = np.sort(rng.uniform(0.3, 0.8, (K, 1)), 0) * np.ones((1, n))
    Kc = np.array([[0.1], [0.3], [1.0]]) * np.ones((1, n))
    Y = (rng.random((ns, K, n)) < S[None]).astype(float)
    orders = np.array([rng.permutation(n)[:30] for _ in range(ns)])
    PA = rng.uniform(0.3, 0.8, (ns, M, K))
    cA = np.tile(Kc[:, 0], (ns, 1))
    ref = np.full(ns, K - 1)
    t0 = 12

    def run(Yx):
        ctl = L3.LCBController(PA, cA, ref, orders.shape[1], 0.95, 0.9, np.random.default_rng(3))
        ctl.setup(30)
        env = L3.Env(Yx, Kc, orders)
        out = []
        for t in range(orders.shape[1]):
            a = ctl.choose(t)
            assert env.reads == list(range(t))  # nothing of task t has been read when choosing for it
            y, c = env.pull(t, a)
            ctl.update(t, a, y, c)
            out.append(a)
        return np.array(out).T

    a1 = run(Y)
    Y2 = Y.copy()
    for s in range(ns):
        Y2[s][:, orders[s, t0:]] = 1 - Y2[s][:, orders[s, t0:]]
    a2 = run(Y2)
    assert (a1[:, : t0 + 1] == a2[:, : t0 + 1]).all()


def test_l3_cheapest_mix():
    p, c = np.array([0.5, 0.6, 0.7]), np.array([0.1, 0.3, 0.5])
    w = L3.cheapest_mix(p, c, np.array(0.55))
    assert abs(w @ p - 0.55) < 1e-9 and abs(w.sum() - 1) < 1e-9
    assert (L3.cheapest_mix(p, c, np.array(0.4)) == [1, 0, 0]).all()
    assert (L3.cheapest_mix(p, c, np.array(0.9)) == [0, 0, 1]).all()


def test_l2_features_use_only_the_first_request():
    from routerml import stage4_workload as L2

    rows = [json.loads(l) for l in L2.QB.open()]
    by = {}
    for r in rows:
        by.setdefault((r["benchmark"], r["instance_id"]), []).append(r)
    keys = sorted(by)[::17]
    base = [L2.first_request(by[k]) for k in keys]
    f = L2.Featurizer("full").fit(base)
    X1 = f.transform(base).toarray()
    mutated = []
    for k in keys:
        rs = copy.deepcopy(by[k])
        first = min(rs, key=lambda x: x["step_index"])
        for r in rs:
            for fld in ("target_tier", "target_tier_id", "total_steps", "benchmark", "scenario", "benchmark_display",
                        "benchmark_subset", "benchmark_version", "pipeline_stage", "collector", "collected_at", "notes", "id"):
                r[fld] = "X"
            if r is not first:  # later steps: scramble completely
                r["messages"] = [{"role": "system", "content": "zzz"}, {"role": "user", "content": "yyy " * 50}]
                r["functions"] = [{"name": "leak"}]
        # in the first request, change the content of assistant / tool messages and of later user messages
        seen_user = False
        for m in first["messages"]:
            if m.get("role") == "user" and not seen_user:
                seen_user = True
                continue
            if m.get("role") != "system":
                m["content"] = "LEAK " * 100
        mutated.append(L2.first_request(rs))
    X2 = f.transform(mutated).toarray()
    assert np.allclose(X1, X2)
    assert set(base[0]) == set(L2.FIRST_REQUEST_FIELDS)
