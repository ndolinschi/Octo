"""Stage 5 guards: deterministic model matching, bandit feedback isolation on trial-draw matrices, the held-out-half
baseline never reads its test half, split-design streams never contain half A."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from conftest import requires_data

from routerml import stage5 as S5
from routerml.stage4_ladder import TS, EpsGreedy
from routerml.xbench_data import TB2_SYS, Target, norm_model

# The declared normalisation, on every raw model string met in the two targets' metadata.
CASES = {
    "anthropic/claude-opus-4-7": "claude-opus-4.7", "claude-opus-4-6": "claude-opus-4.6", "claude-opus-4.6": "claude-opus-4.6",
    "Opus-4.6": "claude-opus-4.6", "claude-4.5-sonnet": "claude-sonnet-4.5", "claude-4.6-opus": "claude-opus-4.6",
    "gemini-3-pro-preview": "gemini-3-pro", "Gemini-3-Flash-Preview": "gemini-3-flash", "gemini-3.1-pro-preview": "gemini-3.1-pro",
    "GLM-4.7": "glm-4.7", "GLM-5": "glm-5", "DeepSeek-V3.2": "deepseek-v3.2", "Kimi-k2.5": "kimi-k2.5",
    "Minimax-m2.5": "minimax-m2.5", "minimax-2.5": "minimax-m2.5", "minimax/MiniMax-M2.7": "minimax-m2.7",
    "minimax-m2-7-highspeed": "minimax-m2.7", "gpt5.1-codex-mini": "gpt-5.1-codex-mini", "GPT-5-Nano": "gpt-5-nano",
    "gpt-5.2": "gpt-5.2", "gpt-5.2-2025-12-11": "gpt-5.2", "gpt-5-mini-2025-08-07": "gpt-5-mini",
    "claude-haiku-4-5-20251001": "claude-haiku-4.5", "gpt-5-2-codex": "gpt-5.2-codex", "qwen3-coder-480b": "qwen3-coder-480b",
}

# Declared matched lists (Verified core arm names), written down from the first run of the matching and kept fixed.
TB2_TERMINUS2 = ["claude-opus-4.6", "deepseek-v3.2", "glm-5", "kimi-k2.5", "minimax-m2.5"]
TB2_ALL = ["claude-opus-4.5", "claude-opus-4.6", "claude-sonnet-4.5", "deepseek-v3.2", "gemini-3-flash", "gemini-3-pro",
           "glm-5", "gpt-5-nano", "gpt-5.2", "kimi-k2.5", "minimax-m2.5"]
MULTILINGUAL = ["claude-haiku-4.5", "claude-opus-4.5", "claude-opus-4.6", "claude-sonnet-4.5", "deepseek-v3.2",
                "gemini-3-flash", "gemini-3-pro", "glm-5", "gpt-5-mini", "gpt-5.2", "kimi-k2.5", "minimax-m2.5"]


@pytest.mark.parametrize("raw,canon", sorted(CASES.items()))
def test_norm_model(raw, canon):
    assert norm_model(raw) == canon
    assert norm_model(raw) == norm_model(raw.upper())  # case-insensitive, deterministic


@requires_data(TB2_SYS, target="xbench-fetch")
def test_matched_lists():
    from routerml.xbench_data import ml_submissions, tb2_matched
    from routerml.stage4_common import load_arms

    s = tb2_matched()
    assert sorted(set(s.loc[s.matched & (s.agent == "Terminus2"), "model"])) == TB2_TERMINUS2
    assert sorted(set(s.loc[s.matched, "model"])) == TB2_ALL
    names = load_arms().names
    assert sorted(set(ml_submissions().model.dropna()) & set(names)) == MULTILINGUAL


def toy_setting(K=4, n=30, D=3, seed=0):
    rng = np.random.default_rng(seed)
    p = rng.uniform(0.2, 0.8, K)
    draws = [[(rng.random(D) < p[k]).astype(float) for _ in range(n)] for k in range(K)]
    costs = [[rng.gamma(2, 0.1, D) * (k + 1) for _ in range(n)] for k in range(K)]
    T = Target("toy", [f"m{k}" for k in range(K)], list(range(n)), draws, costs)
    return S5.setting(T, rng.uniform(0.2, 0.8, K), rng.uniform(0.1, 1, K), np.arange(K) % 3, 0.5 + np.arange(K))


@pytest.mark.parametrize("make", [
    lambda S, ns, T: TS(S.A, ns, T, 1.0, np.random.default_rng(3), prior="flat"),
    lambda S, ns, T: S5.TSPrior(S.A, ns, T, 1.0, np.random.default_rng(3), 20, S.h, S.c),
    lambda S, ns, T: S5.TSPrior(S.A, ns, T, 0.0, np.random.default_rng(3), 5, S.h, S.c, discount=0.99),
    lambda S, ns, T: EpsGreedy(S.A, ns, T, 1.0, np.random.default_rng(3)),
])
def test_feedback_isolation_trials(make):
    """Changing every trial of every (model, task) cell the stream did not choose leaves all decisions unchanged."""
    S = toy_setting()
    ns, T = 8, 60
    orders = np.random.default_rng(1).integers(0, S.n, (ns, T))
    a1 = S5.simulate(make(S, ns, T), S5.TrialEnv(S.Y, S.Kc, S.nd, orders, 9), T)
    Y2, K2 = S.Y.copy(), S.Kc.copy()
    chosen = np.zeros(S.Y.shape[:2], bool)
    for s in range(ns):
        chosen[a1[s], orders[s]] = True
    Y2[~chosen] = 1 - Y2[~chosen]
    K2[~chosen] = K2[~chosen] * 7 + 1
    a2 = S5.simulate(make(S, ns, T), S5.TrialEnv(Y2, K2, S.nd, orders, 9), T)
    assert (a1 == a2).all()


def test_heldout_never_reads_B_and_split_streams_avoid_A():
    S = toy_setting(n=40)
    full, split, inA = S5.streams(S, 5)
    ho = S5.heldout_choice(S.P, S.Cm, 1.0, inA)
    P2, C2 = S.P.copy(), S.Cm.copy()
    rng = np.random.default_rng(2)
    for s in range(len(inA)):
        Pb, Cb = S.P.copy(), S.Cm.copy()
        Pb[:, ~inA[s]] = rng.random((S.K, (~inA[s]).sum()))
        Cb[:, ~inA[s]] = rng.random((S.K, (~inA[s]).sum())) * 10
        assert S5.heldout_choice(Pb, Cb, 1.0, inA[s:s + 1])[0] == ho[s]
    for od in split.values():
        for s in range(len(inA)):
            assert not inA[s][od[s]].any()
