"""Leak test, label-table invariants, split disjointness. Run after `make build features`."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from routerml import config as C
from routerml.build import load_tasks
from routerml.evaluate import FoldFeatures, splits
from routerml.features import STAT_COLUMNS, TfidfSvd, embed, routing_view, text_stats

SCHEMES = ("A_model_terciles", "B_fixed_1_5", "C_submission_terciles")


@pytest.fixture(scope="module")
def tasks():
    return load_tasks().sort_values("instance_id").reset_index(drop=True)


def _scramble_forbidden(df: pd.DataFrame) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    out = df.copy()
    for c in C.FORBIDDEN_FIELDS:
        out[c] = rng.permutation(out[c].to_numpy())  # shuffled across tasks
        out[c] = out[c].astype(str) + " Traceback (most recent call last) foo.py error"
    return out


def test_forbidden_fields_never_reach_features(tasks):
    assert set(C.FORBIDDEN_FIELDS) <= set(tasks.columns), "the test must see the fields it guards"
    a, b = routing_view(tasks), routing_view(_scramble_forbidden(tasks))
    assert not (set(a.columns) & set(C.FORBIDDEN_FIELDS))
    pd.testing.assert_frame_equal(text_stats(a), text_stats(b))
    ta, tb = TfidfSvd(8).fit(a), TfidfSvd(8).fit(b)
    np.testing.assert_allclose(ta.transform(a), tb.transform(b))
    np.testing.assert_allclose(embed(a.head(8)), embed(b.head(8)), atol=1e-6)


def test_feature_functions_reject_raw_frames(tasks):
    with pytest.raises(ValueError):
        text_stats(tasks)
    with pytest.raises(ValueError):
        TfidfSvd(4).fit(tasks)


def test_feature_names_have_no_forbidden_or_repo_source(tasks):
    emb = np.load(C.DATA / "embeddings_minilm.npy")
    ff = FoldFeatures(routing_view(tasks), text_stats(routing_view(tasks)), emb, "stats+tfidf+emb")
    names = ff.names()
    for n in names:
        for f in C.FORBIDDEN_FIELDS:
            assert f.lower() not in n.lower(), n
        # repository / task identity is never a feature (n_version_mentions counts "1.2.3" in the text)
        assert n.split("_")[0] not in ("repo", "instance", "version", "base"), n
    assert names[: len(STAT_COLUMNS)] == STAT_COLUMNS


def test_analysis_columns_kept_apart():
    feats = pd.read_csv(C.RESULTS / "features_textstats.csv")
    assert "difficulty" not in feats.columns
    assert "difficulty" in pd.read_csv(C.RESULTS / "analysis_columns.csv").columns


@pytest.mark.parametrize("scheme", SCHEMES)
@pytest.mark.parametrize("sl", ("core", "full"))
def test_label_table_invariants(scheme, sl, tasks):
    lab = pd.read_csv(C.RESULTS / f"labels_{scheme}_{sl}.csv")
    subs = pd.read_csv(C.RESULTS / "submissions.csv")
    out = pd.read_csv(C.RESULTS / "outcomes_core.csv.gz")
    assert lab["share"].between(0, 1).all()
    assert lab.groupby("instance_id")["tier"].nunique().eq(3).all(), "every task must have all three tiers"
    assert set(lab["instance_id"]) == set(tasks["instance_id"])
    s = subs[subs[f"in_{sl}"]]
    for t in C.TIERS:
        n = int((s[f"tier_{scheme}"] == t).sum())
        assert (lab.loc[lab.tier == t, "count"] == n).all(), (t, n)
    np.testing.assert_allclose(lab["share"], lab["n_resolved"] / lab["count"])
    assert lab["hard"].isin([0, 1]).all()
    if sl == "core":
        core = s[f"tier_{scheme}"].to_dict()
        assert out.submission.nunique() == len(s) and len(out) == len(s) * 500
        del core
    # oracle tier is the cheapest tier with share >= 0.5
    w = lab.pivot(index="instance_id", columns="tier", values="share")
    o = lab.drop_duplicates("instance_id").set_index("instance_id")["oracle_tier"]
    for iid, r in w.iterrows():
        exp = next((t for t in C.TIERS if r[t] >= 0.5), "none")
        assert o[iid] == exp


def test_core_is_single_scaffold_single_model():
    subs = pd.read_csv(C.RESULTS / "submissions.csv")
    core = subs[subs.in_core]
    assert (core.agent == "mini-SWE-agent").all()
    assert (core.n_models == 1).all()
    assert core.blended_per_m.notna().all()
    models = pd.read_csv(C.RESULTS / "models.csv")
    assert models.price_verified.all()
    assert set(core.canon) <= set(models.model)


@pytest.mark.parametrize("kind", ("loro", "gkf4", "time"))
def test_splits_disjoint(kind, tasks):
    seen = []
    for name, tr, te in splits(tasks, kind):
        assert not set(tr) & set(te)
        if kind != "time":
            assert not set(tasks.repo.iloc[tr]) & set(tasks.repo.iloc[te]), name
        else:
            assert tasks.created_at.iloc[tr].max() <= tasks.created_at.iloc[te].min()
        seen.extend(te)
    if kind != "time":
        assert sorted(seen) == list(range(len(tasks)))
