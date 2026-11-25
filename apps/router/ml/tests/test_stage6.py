"""Stage 6: feature list / no leak, label construction, brief cleaning, the router-rule port, split determinism,
curve area, the probe fixture and the exported scorer."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from routerml import config as C
from routerml import stage6_data as D
from routerml import stage6_features as F

from conftest import requires_data

PROBE = C.ROOT / "fixtures" / "stage6_probe.json"


def _tasks(n=40, seed=0):
    rng = np.random.default_rng(seed)
    src = np.array(C.S6_SOURCES)[np.arange(n) % 4]
    return pd.DataFrame(
        dict(
            source=src,
            task_id=[f"t{i}" for i in range(n)],
            uid=[f"{s}::t{i}" for i, s in enumerate(src)],
            group=[f"{s}:g{i % 7}" for i, s in enumerate(src)],
            title=["Fix it" if i % 3 else "" for i in range(n)],
            brief=[("rename foo to bar in utils.ts " * (1 + i % 5)) for i in range(n)],
            tools=[["Read", "Edit"] for _ in range(n)],
            depth=1,
            created="",
            brief_descriptive="x",
            leak_difficulty=rng.choice(["easy", "hard"], n),
            leak_constraints="1 <= n <= 10^5",
            leak_starter="def f(): pass",
            leak_platform="leetcode",
            leak_solution="return 1",
            leak_tests="assert f() == 1",
            leak_libs="[]",
            leak_hints="",
            leak_n_public_tests=2,
        )
    )


# ------------------------------------------------------------------------------------------------ features
def test_feature_list_is_what_the_router_sees():
    assert F.FEATURE_FIELDS == ("title", "brief", "tools", "depth")
    assert not set(F.FEATURE_FIELDS) & set(F.LEAK_FIELDS)
    t = _tasks()
    assert list(F.delegation_view(t).columns) == list(F.FEATURE_FIELDS)
    with pytest.raises(ValueError):
        F.text_stats(t[["title", "brief", "tools", "depth", "leak_solution"]])
    # every leak column of the task table is declared as one
    assert {c for c in t.columns if c.startswith("leak_")} <= set(F.LEAK_FIELDS)


def test_scrambling_leak_fields_changes_no_feature():
    t = _tasks()
    a = F.text_stats(F.delegation_view(t))
    s = t.copy()
    rng = np.random.default_rng(1)
    for c in F.LEAK_FIELDS:
        if c in s:
            s[c] = rng.permutation(s[c].to_numpy())
    b = F.text_stats(F.delegation_view(s))
    pd.testing.assert_frame_equal(a, b)
    assert F.texts(F.delegation_view(t)) == F.texts(F.delegation_view(s))


def test_task_text_as_the_router_builds_it():
    assert F.task_text("T", "B") == "T\n\nB"
    assert F.task_text("", " B ") == "B"
    assert F.task_text("T", "") == "T"


def test_router_rule_port():
    assert F.router_rule_band("Fix the typo in the README heading.") == 0
    assert F.router_rule_band("Traceback (most recent call last): boom") == 2
    assert F.router_rule_band("Fix it and add a test.") == 1
    assert F.router_rule_band("Change a.py and b.py, then run the tests.") == 2  # two paths + tests
    assert F.router_rule_band("x " * 800) == 1  # long only: one signal
    assert F.router_rule_band("Look at the repo and list files in src") == 1  # asks to inspect: not easy


# ------------------------------------------------------------------------------------------------ labels
def _built():
    tasks = pd.DataFrame(dict(uid=["s::a", "s::b"], source=["canitedit", "canitedit"]))
    prices = pd.DataFrame(
        dict(source="canitedit", model=["m1", "m2", "m3", "m4"], blended_per_m=[0.1, 0.5, 2.0, 6.0], tier_A=["low", "low", "mid", "high"], tier_B=["low", "low", "mid", "high"])
    )
    o = pd.DataFrame(
        dict(
            uid=["s::a"] * 4 + ["s::b"] * 4,
            source="canitedit",
            model=["m1", "m2", "m3", "m4"] * 2,
            score=[1, 0, 1, 1, 0, 0, 0, 0.4],
        )
    ).merge(prices, on=["source", "model"])
    return dict(tasks=tasks, outcomes=o, prices=prices, tokens={"canitedit": 1_000_000})


def test_soft_labels_costs_and_cheapest_sufficient():
    b = _built()
    S, K = D.labels(b, "A")
    np.testing.assert_allclose(S, [[0.5, 1.0, 1.0], [0.0, 0.0, 0.4]])
    np.testing.assert_allclose(K[0], [0.3, 2.0, 6.0])  # tier mean price x 1M tokens / 1M
    assert D.cheapest_sufficient(S).tolist() == [0, 3]  # 0.5 counts as sufficient; nothing >= 0.5 -> none
    S2, _ = D.labels(b, "A", {"canitedit": {"m2", "m3", "m4"}})
    assert S2[0, 0] == 0.0


def test_tier_cut_points_are_stage_1_scheme_a():
    assert C.S6_CUTS["A"] == (0.8, 3.4375)
    assert D.assign(0.7999, C.S6_CUTS["A"]) == "low"
    assert D.assign(0.8, C.S6_CUTS["A"]) == "mid"
    assert D.assign(3.4375, C.S6_CUTS["A"]) == "high"
    assert D.blended(1.0, 5.0) == 2.0


def test_brief_cleaning_removes_leaky_sections():
    lc = "Find x.\n\nExample 1:\nInput: 1\n\nConstraints:\n\n1 <= n <= 10^5\n\nFollow-up: Can you do it in O(n)?"
    brief, removed = D.split_lcb(lc, "leetcode")
    assert brief == "Find x.\n\nExample 1:\nInput: 1" and "10^5" in removed and "O(n)" in removed
    ac = "Count.\n\nInput\n\nN\n\nOutput\n\nPrint.\n\nConstraints\n\n\n- 1 \\leq N \\leq 10^5\n\nSample Input 1\n\n3"
    brief, removed = D.split_lcb(ac, "atcoder")
    assert "leq" not in brief and "Sample Input 1" in brief and "10^5" in removed
    bcb = "Do a thing with pandas.\nYou should write self-contained code starting with:\n```\nimport pandas as pd\ndef task_func(df):\n```"
    brief, starter = D.split_bcb(bcb)
    assert brief == "Do a thing with pandas." and "import pandas" in starter


# ------------------------------------------------------------------------------------------------ splits + curves
def test_folds_are_deterministic_grouped_and_cover_everything():
    from routerml.stage6_eval import fold_ids, folds

    t = _tasks(200)
    a, b = fold_ids(t), fold_ids(t)
    assert (a == b).all()
    assert t.assign(f=a).groupby("group").f.nunique().max() == 1  # a group never straddles folds
    seen = np.zeros(len(t), int)
    for _, tr, te in folds(t, "pooled"):
        assert not set(tr) & set(te)
        seen[te] += 1
    assert (seen == 1).all()
    for s, tr, te in folds(t, "loso"):
        assert set(t.source.iloc[te]) == {s} and s not in set(t.source.iloc[tr])


def test_curve_area_orders_oracle_mixture_and_bounds():
    from routerml.stage6_eval import Curves, fixed_choices, prob_choices

    rng = np.random.default_rng(0)
    n = 300
    S = np.sort(rng.random((n, 3)), axis=1)
    K = np.tile([1.0, 3.0, 10.0], (n, 1))
    g = np.array([f"g{i % 30}" for i in range(n)])
    src = np.array(["canitedit"] * n)
    cur = Curves(S, K, np.arange(n), g, src, n_boot=20)
    mix = cur.areas(fixed_choices(n))
    orc = cur.areas(prob_choices(S, K / K[:, 2:3]))
    assert orc[0] >= mix[0] - 1e-12
    assert S[:, 0].mean() - 1e-9 <= mix[0] <= S[:, 2].mean() + 1e-9
    assert mix.shape == (21,)


# ------------------------------------------------------------------------------------------------ probe fixture
def test_probe_fixture_is_balanced_and_complete():
    p = json.loads(PROBE.read_text())["briefs"]
    assert len(p) == 60
    assert {x["band"] for x in p} == {"easy", "medium", "hard"}
    assert all(sum(x["band"] == b for x in p) == 20 for b in ("easy", "medium", "hard"))
    assert len({x["id"] for x in p}) == 60
    assert all(x["brief"] and isinstance(x["tools"], list) and x["depth"] == 1 for x in p)


# ------------------------------------------------------------------------------------------------ with data
@requires_data("stage6/manifest.json", target="stage6-fetch")
def test_real_task_table_carries_no_leak_into_features():
    b = D.build()
    t = b["tasks"]
    assert set(t.source) == set(C.S6_SOURCES)
    a = F.text_stats(F.delegation_view(t))
    s = t.copy()
    rng = np.random.default_rng(2)
    for c in F.LEAK_FIELDS:
        if c in s:
            s[c] = rng.permutation(s[c].to_numpy())
    pd.testing.assert_frame_equal(a, F.text_stats(F.delegation_view(s)))
    # the default brief has the constraints / starter code removed
    lc = t[(t.source == "livecodebench") & (t.leak_platform == "leetcode")]
    assert not lc.brief.str.contains(r"\nConstraints:").any()
    assert not t[t.source == "bigcodebench"].brief.str.contains("self-contained code starting with").any()
    S, K = D.labels(b, "A")
    assert np.isfinite(S).all() and (np.diff(K, axis=1) > 0).all()


@requires_data(C.ROOT / "models" / "m2_delegation.onnx", hint="run `make stage6` (the m2 step) in apps/router/ml")
def test_exported_scorer_runs_with_onnxruntime_only():
    from routerml.stage6_score import Scorer, choose

    p = Scorer().score("Rename the variable foo to bar in src/utils.ts.")
    assert p.shape == (3,) and ((p >= 0) & (p <= 1)).all()
    assert choose(np.array([0.2, 0.6, 0.9]), 0.5) == "mid" and choose(np.array([0.1, 0.1, 0.1]), 0.5) == "high"
