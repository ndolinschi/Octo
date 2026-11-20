"""Stage 6, part 4: the transfer probe (results/stage6_probe.json).

60 hand-written delegation briefs (fixtures/stage6_probe.json) with a-priori bands recorded before any model scored
them. No outcomes exist for them: this is a sanity probe of how the trained models rank realistic briefs, not evidence
of solved rate. Scored by: M1' trained on all four sources, M2' (models/m2_delegation.onnx through the reference
scorer), the fitted length-only model, and the router's own text rule.

Reported: Spearman between each model's predicted difficulty (1 - p_low) and the band (easy 0 < medium 1 < hard 2);
the tier each picks with the design's rule at tau = 0.5 against the band (confusion table); the worst misses.
"""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config as C
from . import stage6_data as D
from . import stage6_features as F
from .stage6_eval import Feats, logistic_predict, m1_predict

BAND = {"easy": 0, "medium": 1, "hard": 2}


def load_probe() -> pd.DataFrame:
    p = json.loads((C.ROOT / "fixtures" / "stage6_probe.json").read_text())["briefs"]
    return pd.DataFrame(p)


def choose(P: np.ndarray, tau: float = 0.5) -> np.ndarray:
    ok = P >= tau
    return np.where(ok.any(1), ok.argmax(1), 2)


def summarise(name: str, P: np.ndarray | None, tier: np.ndarray, probe: pd.DataFrame) -> dict:
    band = probe.band.map(BAND).to_numpy()
    out = {}
    if P is not None:
        diff = 1 - P[:, 0]
        out["spearman_difficulty_vs_band"] = round(float(pd.Series(diff).corr(pd.Series(band), method="spearman")), 3)
        out["mean_p_low_by_band"] = {b: round(float(P[band == v, 0].mean()), 3) for b, v in BAND.items()}
        order = np.argsort(diff)
        easy_as_hard = [i for i in order[::-1] if band[i] == 0][:3]
        hard_as_easy = [i for i in order if band[i] == 2][:3]
        out["worst_misses"] = {
            "easy briefs scored hardest": [{"id": probe.id[i], "brief": probe.brief[i], "p": np.round(P[i], 3).tolist()} for i in easy_as_hard],
            "hard briefs scored easiest": [{"id": probe.id[i], "brief": probe.brief[i], "p": np.round(P[i], 3).tolist()} for i in hard_as_easy],
        }
        P_all = P
    else:
        P_all = None
    out["spearman_tier_vs_band"] = round(float(pd.Series(tier).corr(pd.Series(band), method="spearman")), 3) if np.std(tier) > 0 else None
    tab = pd.crosstab(pd.Series(probe.band, name="band"), pd.Series(np.array(D.TIERS)[tier], name="tier")).reindex(index=list(BAND), columns=list(D.TIERS), fill_value=0)
    out["confusion_band_x_tier_at_tau_0.5"] = tab.to_dict("index")
    out["agreement_band_eq_tier"] = round(float(np.mean(tier == band)), 3)
    _ = (name, P_all)
    return out


def main() -> None:
    b = D.build()
    tasks = b["tasks"]
    S, _ = D.labels(b, "A")
    probe = load_probe()
    both = pd.concat(
        [tasks[["title", "brief", "tools", "depth", "group"]], probe.assign(group=["probe:" + x for x in probe.id])[["title", "brief", "tools", "depth", "group"]]],
        ignore_index=True,
    )
    n = len(tasks)
    Sb = np.vstack([S, np.full((len(probe), 3), np.nan)])
    tr, te = np.arange(n), np.arange(n, len(both))
    feats = Feats(both)
    res = {"n_briefs": len(probe), "note": "sanity probe: no outcomes exist for these briefs; bands were written before scoring"}
    _, cal = m1_predict(feats, Sb, both.group.to_numpy(), tr, te)
    res["M1'"] = summarise("M1'", cal, choose(cal), probe)
    loglen = F.text_stats(F.delegation_view(both))["log_chars"].to_numpy()
    Pl, _ = logistic_predict(loglen[:, None], Sb, tr, te)
    res["length-only (fitted)"] = summarise("len", Pl, choose(Pl), probe)
    rule = np.array([F.router_rule_band(x) for x in F.texts(F.delegation_view(probe))])
    res["router text rule (band -> tier)"] = summarise("rule", None, rule, probe)
    onnx = C.ROOT / "models" / "m2_delegation.onnx"
    if onnx.exists():
        from .stage6_score import Scorer

        sc = Scorer(onnx)
        P2 = np.vstack([sc.score(x) for x in F.texts(F.delegation_view(probe))]).astype(float)
        res["M2' (int8 ONNX)"] = summarise("M2'", P2, choose(P2), probe)
        res["M2' scores"] = {i: np.round(p, 3).tolist() for i, p in zip(probe.id, P2)}
    res["M1' scores"] = {i: np.round(p, 3).tolist() for i, p in zip(probe.id, cal)}
    (C.RESULTS / "stage6_probe.json").write_text(json.dumps(res, indent=1))
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "worst_misses"} for k, v in res.items() if isinstance(v, dict) and "scores" not in k}, indent=1))


if __name__ == "__main__":
    main()
