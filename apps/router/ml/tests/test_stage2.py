"""Stage 2 invariants: disjoint split halves, no post-K information in early features, out-of-fold detector,
bandit feedback limited to the chosen arm. Synthetic inputs only (no data download needed)."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from routerml.bandit import Beta, Env, LagrangianTS, ThresholdEB, simulate
from routerml.cascade import loro_scores
from routerml.ceiling import split_rows
from routerml.trajectories import early_features, features_at


def test_split_halves_disjoint_and_cover_every_tier():
    rng = np.random.default_rng(0)
    tier = np.array([0] * 12 + [1] * 11 + [2] * 16)
    for frac in (0.25, 0.5, 0.75):
        for _ in range(50):
            a, b = split_rows(tier, rng, frac)
            assert not set(a) & set(b)
            assert sorted(np.r_[a, b]) == list(range(len(tier)))
            for t in range(3):
                assert (tier[a] == t).any() and (tier[b] == t).any()


def _step(cmd, rc=0, thought="look", n=1):
    return {"thought": thought, "cmds": [cmd], "cost": 0.01, "rc": [rc] * n, "obs_len": 100, "tb": 0, "tpass": 0, "tfail": 0, "nonobs": 0}


def test_early_features_ignore_everything_after_step_k():
    rng = np.random.default_rng(1)
    base = [_step(f"cat a{i}.py") for i in range(30)]
    for K in (5, 10, 20):
        other = [dict(s) for s in base]
        for j in range(K, 30):  # rewrite the future: failures, edits, tests, submission, long outputs
            other[j] = _step("pytest -x && sed -i s/a/b/ x.py && echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT", rc=1,
                             thought="still fails, error again " * 5)
            other[j]["obs_len"] = int(rng.integers(1, 10**6))
            other[j]["tb"], other[j]["tfail"], other[j]["nonobs"] = 3, 1, 2
        a = features_at({"steps": base}, K)
        b = features_at({"steps": other + [_step("ls")] * 7}, K)  # also a different total length (> K)
        np.testing.assert_array_equal(a, b)
    # the one bit of the future that is allowed: whether the run had ended by K
    short = base[:8]
    assert features_at({"steps": short}, 10)[0] == 1.0 and features_at({"steps": base}, 10)[0] == 0.0
    np.testing.assert_array_equal(features_at({"steps": short}, 10)[1:], early_features(short, True)[1:])


def test_posthoc_detector_is_out_of_fold_by_repository():
    rng = np.random.default_rng(2)
    n, ns = 120, 3
    repos = np.repeat(np.arange(4), n // 4)
    R = (rng.random((ns, n)) < 0.5).astype(float)
    calls = rng.integers(5, 250, (ns, n)).astype(float)
    cost = rng.random((ns, n))
    base = loro_scores(SimpleNamespace(R=R, calls=calls, cost=cost), list(range(ns)), repos)
    R2 = R.copy()
    R2[:, repos == 2] = 1 - R2[:, repos == 2]  # flip the held-out repository's labels
    flip = loro_scores(SimpleNamespace(R=R2, calls=calls, cost=cost), list(range(ns)), repos)
    for k in base:
        np.testing.assert_allclose(base[k][:, repos == 2], flip[k][:, repos == 2])


def test_bandit_sees_only_the_chosen_arm():
    rng = np.random.default_rng(3)
    ns, nt, nr = 20, 60, 3
    S = rng.random((nt, 3))
    Kc = np.tile([0.1, 0.3, 0.5], (nt, 1))
    repo_id = np.repeat(np.arange(nr), nt // nr)
    orders = np.array([rng.permutation(nt) for _ in range(ns)])
    Y = (rng.random((ns, nt, 3)) < S[None]).astype(float)
    m = np.tile(S.mean(0), (nr, 1))
    ctx = {"m": m, "c": np.tile(Kc.mean(0), (nr, 1)), "n0": np.full((nr, 3), 10.0), "n_streams": ns, "n_repo": nr,
           "lam": 0.5, "mu0": 2.0}
    for fac in (lambda c, r: Beta(c, r, "ts", True), lambda c, r: Beta(c, r, "ucb", False), LagrangianTS, ThresholdEB):
        _, arms, env = simulate(fac, S, Kc, repo_id, orders, Y, ctx, 7)
        chosen = np.zeros_like(Y, bool)
        for task, arm in env.log:
            chosen[np.arange(ns), task, arm] = True
        Y2 = np.where(chosen, Y, 1 - Y)  # every outcome the policy did not observe is flipped
        _, arms2, _ = simulate(fac, S, Kc, repo_id, orders, Y2, ctx, 7)
        np.testing.assert_array_equal(arms, arms2)
    env = Env(Y, Kc)
    y, c = env.pull(orders[:, 0], np.zeros(ns, int))
    assert y.shape == (ns,) and c.shape == (ns,)
