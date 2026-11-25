"""Stage 3, check 3 (last part): what would it cost to generate more TwinRouterBench-style step labels?

An ESTIMATE from the benchmark's own construction algorithm (docs/DATA_GENERATION.md: strong-model seed trajectory;
then, step by step with earlier steps locked, a candidate tier at the current step and `high` for every later step,
executed to the end and evaluated; up to three models per candidate tier; cheapest tier first) and its own price
table and cost model (main/pricing.py, main/eval/section11 with the real tokenizers). Nothing is called.
Per routed step i of a trajectory with gold tier g: trials = (models tried in tiers below g, all failing) + (models
tried in g until one passes). Assumed: 3 per failing tier, 2 (expected) in the passing tier; for g = high, the
9 lower-tier trials all fail and high is the seed. Each trial costs the always-high suffix from step i (the
candidate's own step is billed at high too: an upper bound of a few per cent). The seed costs the full always-high
trajectory. Docker/evaluation compute and the review pass are not priced.
"""

from __future__ import annotations

import numpy as np

from .stage2 import save
from .stage3_steps import TIERS4, WORKLOADS, Scorer, load_rows

TRIALS = {0: 2, 1: 3 + 2, 2: 6 + 2, 3: 9}


def main():
    rows = load_rows()
    sc = Scorer(rows)
    gold = np.array([r["target_tier_id"] for r in rows])
    recs = sc.recs(np.full(len(gold), 3), gold)
    per = {}
    for rec in sc.s11._iter_trajectory_step_costs(recs):
        s = rec["step"]
        per.setdefault(rec["instance_id"], []).append((s["step_index"], rec["baseline_cost"], s["gold_tier_id"], s["benchmark"]))
    out = {"method": __doc__, "trials_per_step_by_gold": {TIERS4[k]: v for k, v in TRIALS.items()}, "by_workload": {}}
    tot = {"seed": 0.0, "trials": 0.0, "n": 0}
    for b in WORKLOADS:
        seeds, trials, steps = [], [], []
        for iid, st in per.items():
            if not iid.startswith(b + "/"):
                continue
            st.sort()
            c = np.array([x[1] for x in st])
            suffix = np.cumsum(c[::-1])[::-1]
            seeds.append(c.sum())
            trials.append(sum(TRIALS[x[2]] * suffix[i] for i, x in enumerate(st)))
            steps.append(len(st))
        seeds, trials = np.array(seeds), np.array(trials)
        out["by_workload"][b] = {"trajectories": len(seeds), "mean_routed_steps": float(np.mean(steps)),
                                 "seed_usd_per_trajectory": float(seeds.mean()),
                                 "search_usd_per_trajectory": float(trials.mean()),
                                 "total_usd_per_trajectory": float((seeds + trials).mean()),
                                 "total_usd_whole_workload": float((seeds + trials).sum())}
        tot["seed"] += seeds.sum()
        tot["trials"] += trials.sum()
        tot["n"] += len(seeds)
    out["all_520"] = {"usd": tot["seed"] + tot["trials"], "per_trajectory": (tot["seed"] + tot["trials"]) / tot["n"]}
    swe = out["by_workload"]["swebench"]["total_usd_per_trajectory"]
    out["swe_scaleup"] = {n: n * swe for n in (100, 500, 2000, 10000)}
    save("stage3_gencost.json", out)
    print(out["by_workload"], out["all_520"], out["swe_scaleup"])


if __name__ == "__main__":
    main()
