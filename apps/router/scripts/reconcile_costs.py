#!/usr/bin/env python3
"""Compare Octo history cost_micros against an optional provider CSV invoice."""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path


def load_billed_as(prices_toml: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    if not prices_toml.is_file():
        return mapping
    current: str | None = None
    for raw in prices_toml.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[prices.") and line.endswith("]"):
            slug = line[len("[prices.") : -1].strip().strip('"').strip("'")
            current = slug
            mapping.setdefault(slug, slug)
            continue
        if current and line.startswith("billed_as"):
            _, _, value = line.partition("=")
            mapping[current] = value.strip().strip('"').strip("'")
    return mapping


def load_provider_csv(path: Path | None) -> dict[tuple[str, str], float]:
    if path is None:
        return {}
    out: dict[tuple[str, str], float] = {}
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            day = row["date"].strip()
            model = row["model"].strip()
            cost = float(row["cost"])
            out[(day, model)] = out.get((day, model), 0.0) + cost
    return out


def micros_to_usd(micros: int | None) -> float:
    if micros is None:
        return 0.0
    return micros / 1_000_000.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("history_db", type=Path, help="Path to history SQLite DB")
    parser.add_argument(
        "--provider-csv",
        type=Path,
        default=None,
        help="Optional CSV with columns date,model,requests,cost",
    )
    parser.add_argument(
        "--prices",
        type=Path,
        default=Path("config/prices.toml"),
        help="prices.toml for billed_as mapping",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.05,
        help="Relative abs(diff) flag threshold (default 0.05 = 5 percent)",
    )
    args = parser.parse_args()

    billed_as = load_billed_as(args.prices)
    provider = load_provider_csv(args.provider_csv)

    conn = sqlite3.connect(args.history_db)
    rows = conn.execute(
        """
        SELECT
            date(created_at / 1000, 'unixepoch') AS day,
            COALESCE(model, '') AS model,
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(CASE WHEN cost_source = 'estimate' THEN cost_micros ELSE 0 END), 0) AS estimate_micros,
            COALESCE(SUM(CASE WHEN cost_source = 'upstream' THEN cost_micros ELSE 0 END), 0) AS upstream_micros,
            COALESCE(SUM(CASE WHEN cost_source = 'openrouter' THEN cost_micros ELSE 0 END), 0) AS openrouter_micros,
            COALESCE(SUM(CASE WHEN cost_source = 'none' OR cost_source IS NULL THEN 0 ELSE cost_micros END), 0) AS total_micros,
            COALESCE(SUM(CASE WHEN cost_source = 'none' OR cost_source IS NULL THEN 1 ELSE 0 END), 0) AS none_calls
        FROM calls
        GROUP BY day, model
        ORDER BY day, model
        """
    ).fetchall()

    print(
        "day,model,billed_as,calls,input_tokens,output_tokens,"
        "cost_estimate_usd,cost_upstream_usd,cost_openrouter_usd,cost_total_usd,"
        "provider_usd,diff_pct,flag"
    )
    flagged = 0
    for (
        day,
        model,
        calls,
        input_tokens,
        output_tokens,
        estimate_micros,
        upstream_micros,
        openrouter_micros,
        total_micros,
        _none_calls,
    ) in rows:
        alias = billed_as.get(model, model)
        estimate = micros_to_usd(estimate_micros)
        upstream = micros_to_usd(upstream_micros)
        openrouter = micros_to_usd(openrouter_micros)
        total = micros_to_usd(total_micros)
        provider_usd = provider.get((day, alias))
        if provider_usd is None:
            provider_usd = provider.get((day, model))
        diff_pct = ""
        flag = ""
        if provider_usd is not None:
            base = max(abs(provider_usd), abs(total), 1e-9)
            rel = abs(total - provider_usd) / base
            diff_pct = f"{rel * 100:.2f}"
            if rel > args.threshold:
                flag = "DIFF>5%"
                flagged += 1
        provider_cell = "" if provider_usd is None else f"{provider_usd:.6f}"
        print(
            f"{day},{model},{alias},{calls},{input_tokens},{output_tokens},"
            f"{estimate:.6f},{upstream:.6f},{openrouter:.6f},{total:.6f},"
            f"{provider_cell},{diff_pct},{flag}"
        )

    if flagged:
        print(f"# flagged rows: {flagged}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
