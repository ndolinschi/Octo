"""Stage 3 invariants: exact hull area, the corrected ceiling is never below stage 2's, the latent noise model keeps
marginals and hits the target disagreement, thresholding is monotone in q. Synthetic inputs only."""

from __future__ import annotations

import numpy as np

from routerml.evaluate import curve_metrics, fixed_points, utility_points
from routerml.stage3_audit import exact_area
from routerml.stage3_steps import threshold
from routerml.stage3_triples import latent


def _synth(rng, n=300):
    p = rng.random((n, 1))
    S = np.clip(p + np.array([[-0.3, -0.1, 0.0]]) + rng.normal(0, 0.1, (n, 3)), 0, 1)
    K = np.column_stack([rng.uniform(0.05, 0.2, n), rng.uniform(0.2, 0.4, n), rng.uniform(0.4, 0.8, n)])
    return S, K


def test_exact_area_matches_stage2_trapezoid():
    rng = np.random.default_rng(0)
    for _ in range(20):
        S, K = _synth(rng)
        fx = fixed_points(S, K)
        pts = utility_points(S, S, K, K)
        a2 = curve_metrics(pts, S, K)["auc_norm"]
        a3 = exact_area(np.vstack([pts, fx[[0, 2]]]), fx[0, 0])
        assert abs(a2 - a3) < 2e-4


def test_with_mid_never_below_stage2_definition():
    rng = np.random.default_rng(1)
    for _ in range(20):
        S, K = _synth(rng)
        Sb = np.clip(S + rng.normal(0, 0.2, S.shape), 0, 1)
        fx = fixed_points(Sb, K)
        pts = utility_points(S, Sb, K, K)
        stage2 = exact_area(np.vstack([pts, fx[[0, 2]]]), fx[0, 0]) - exact_area(fx, fx[0, 0])
        with_mid = exact_area(np.vstack([pts, fx]), fx[0, 0]) - exact_area(fx, fx[0, 0])
        assert with_mid >= stage2 - 1e-12 and with_mid >= -1e-12


def test_latent_noise_keeps_marginal_and_disagreement():
    rng = np.random.default_rng(2)
    for r in (0.3, 0.55, 0.77):
        y = (rng.random(2000) < r).astype(float)
        for d in (0.12, 0.168):
            pi = latent(y, d)
            assert abs(pi.mean() - y.mean()) < 1e-9
            assert abs(np.mean(2 * pi * (1 - pi)) - d) < 1e-6


def test_threshold_monotone_in_q():
    rng = np.random.default_rng(3)
    P = rng.dirichlet(np.ones(4), 500)
    prev = threshold(P, 0.05)
    for q in np.linspace(0.1, 0.999, 30):
        cur = threshold(P, q)
        assert (cur >= prev).all()
        prev = cur
    assert (threshold(P, 1.5) == 3).all()
