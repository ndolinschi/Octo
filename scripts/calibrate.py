#!/usr/bin/env python3
"""Grid-search autoroute hard/easy thresholds against eval JSONL + decisions."""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open() as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def load_decisions(db: Path) -> dict[str, list[tuple[float | None, float | None]]]:
    conn = sqlite3.connect(db)
    cur = conn.execute(
        """
        SELECT session_id, is_hard_score, is_easy_score
        FROM decisions
        WHERE session_id IS NOT NULL
        ORDER BY created_at ASC
        """
    )
    out: dict[str, list[tuple[float | None, float | None]]] = defaultdict(list)
    for session_id, hard, easy in cur.fetchall():
        out[str(session_id)].append((hard, easy))
    conn.close()
    return out


def complexity(hard: float | None, easy: float | None, hard_t: float, easy_t: float) -> str:
    if hard is None or easy is None:
        return "mid"
    is_hard = hard >= hard_t
    is_easy = easy >= easy_t
    if is_hard and not is_easy:
        return "high"
    if (not is_hard) and is_easy:
        return "low"
    return "mid"


def arm_stats(rows: list[dict]) -> dict[str, dict[str, float]]:
    by_arm: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_arm[str(row["arm"])].append(row)
    stats = {}
    for arm, items in by_arm.items():
        solved = sum(1 for item in items if item.get("solved"))
        cost = sum(float(item.get("cost_micros") or 0) for item in items)
        n = len(items)
        stats[arm] = {
            "solve_rate": solved / n if n else 0.0,
            "cost_micros": cost / n if n else 0.0,
            "n": float(n),
        }
    return stats


def task_arm_lookup(rows: list[dict]) -> dict[tuple[str, str], dict]:
    out = {}
    for row in rows:
        key = (str(row["arm"]), str(row["task"]))
        bucket = out.setdefault(key, {"solved": 0, "n": 0, "cost": 0.0})
        bucket["n"] += 1
        bucket["cost"] += float(row.get("cost_micros") or 0)
        if row.get("solved"):
            bucket["solved"] += 1
    return out


def session_tier(
    session_id: str,
    decisions: dict[str, list[tuple[float | None, float | None]]],
    hard_t: float,
    easy_t: float,
) -> str:
    scores = decisions.get(session_id) or []
    if not scores:
        return "mid"
    hard, easy = scores[0]
    return complexity(hard, easy, hard_t, easy_t)


def evaluate(
    eval_rows: list[dict],
    decisions: dict[str, list[tuple[float | None, float | None]]],
    hard_t: float,
    easy_t: float,
    oracle: dict[tuple[str, str], dict],
) -> tuple[float, float, list[int]]:
    tasks = sorted({str(row["task"]) for row in eval_rows})
    solved_flags: list[int] = []
    total_cost = 0.0
    for task in tasks:
        sessions = {
            str(row["session_id"])
            for row in eval_rows
            if str(row["task"]) == task and row.get("session_id")
        }
        if not sessions:
            sessions = {f"task:{task}"}
        tiers = [session_tier(session, decisions, hard_t, easy_t) for session in sessions]
        tier = max(tiers, key=["low", "mid", "high"].index)
        arm = f"always-{tier}"
        stats = oracle.get((arm, task))
        if stats is None:
            solved_flags.append(0)
            continue
        rate = stats["solved"] / stats["n"] if stats["n"] else 0.0
        solved_flags.append(1 if rate >= 0.5 else 0)
        total_cost += stats["cost"] / stats["n"] if stats["n"] else 0.0
    n = len(solved_flags) or 1
    solve_rate = sum(solved_flags) / n
    solved = sum(solved_flags) or 1
    cost_per_solved = (total_cost / 1_000_000.0) / solved
    return solve_rate, cost_per_solved, solved_flags


def bootstrap_ci(flags: list[int], samples: int = 10_000, seed: int = 0) -> tuple[float, float]:
    rng = random.Random(seed)
    n = len(flags)
    if n == 0:
        return 0.0, 0.0
    rates = []
    for _ in range(samples):
        draw = [flags[rng.randrange(n)] for _ in range(n)]
        rates.append(sum(draw) / n)
    rates.sort()
    lo = rates[int(0.025 * (samples - 1))]
    hi = rates[int(0.975 * (samples - 1))]
    return lo, hi


def grid(step: float) -> list[float]:
    values = []
    x = 0.0
    while x <= 1.0000001:
        values.append(round(x, 10))
        x += step
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval", type=Path, required=True, help="eval JSONL from step 1")
    parser.add_argument("--db", type=Path, required=True, help="history sqlite with decisions")
    parser.add_argument("--cost-target", type=float, default=0.05, help="$ per solved task")
    parser.add_argument("--step", type=float, default=0.05)
    args = parser.parse_args()

    eval_rows = load_jsonl(args.eval)
    decisions = load_decisions(args.db)
    oracle = task_arm_lookup(eval_rows)

    best = None
    for hard_t in grid(args.step):
        for easy_t in grid(args.step):
            solve_rate, cost_per_solved, flags = evaluate(
                eval_rows, decisions, hard_t, easy_t, oracle
            )
            if cost_per_solved > args.cost_target:
                continue
            candidate = (solve_rate, -cost_per_solved, hard_t, easy_t, flags)
            if best is None or candidate[:4] > best[:4]:
                best = candidate

    if best is None:
        print("no threshold pair met the cost target", file=sys.stderr)
        return 1

    solve_rate, neg_cost, hard_t, easy_t, flags = best
    lo, hi = bootstrap_ci(flags)
    print(
        json.dumps(
            {
                "hard_threshold": hard_t,
                "easy_threshold": easy_t,
                "solve_rate": solve_rate,
                "cost_per_solved": -neg_cost,
                "bootstrap_95": [lo, hi],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
