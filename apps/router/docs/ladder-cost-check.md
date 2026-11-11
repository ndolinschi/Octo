# Ladder cost check (2026-11-10)

Comparison of `config/prices.toml` against the public OpenRouter catalogue (`GET https://openrouter.ai/api/v1/models`, unauthenticated, fetched 2026-11-10). Prices are USD per 1M tokens. The "30k in / 500 out" column is `30000 * input + 500 * output` in micro-USD, ignoring cache.

## Ladder models (`config/autoroute.toml`)

| Model | Tier | Catalogue in / out / cache read | `prices.toml` before | `prices.toml` after | 30k in / 500 out |
| --- | --- | --- | --- | --- | --- |
| `deepseek/deepseek-v4.1-flash` | low | 0.30 / 1.20 / 0.006 | 0.051 / 0.567 / 0.018 | 0.30 / 1.20 / 0.006 | before 1,813 -> after 9,600 ($0.0096) |
| `minimax/minimax-m3.1-flash` | mid | peak 0.15 / 0.60 / 0.015; off-peak (UTC 15:00-01:00) 0.075 / 0.30 / 0.0075 | 0.15 / 0.60 / 0.015 | unchanged (peak rate kept) | 4,800 peak, 2,400 off-peak |
| `deepseek/deepseek-v4.1-flash-1017` | high | 0.006 / 0.50 / 0.005 | 0.006 / 0.50 / 0.005 | unchanged | 430 ($0.00043) |

The catalogue publishes no cache-write price for any of them; `cache_write` stays `0.0`.

## Other rows in `prices.toml` (not in the ladder)

| Model | Catalogue in / out / cache read | Before | After | 30k in / 500 out |
| --- | --- | --- | --- | --- |
| `mistralai/mistral-nemo` | 0.029 / 0.03 / none | all 0.0 | 0.029 / 0.03 / 0.0 | 885 |
| `mistralai/ministral-8b-2512` | 0.15 / 0.15 / 0.015 | all 0.0 | 0.15 / 0.15 / 0.015 | 4,575 |
| `mistralai/mistral-small-3.1-24b-instruct` | 0.351 / 0.555 / none | all 0.0 | 0.351 / 0.555 / 0.0 | 10,807 |
| `mistralai/mistral-small-3.2-24b-instruct` | 0.10 / 0.30 / 0.01 | all 0.0 | 0.10 / 0.30 / 0.01 | 3,150 |
| `deepseek/deepseek-v4-flash` | 0.091 / 0.182 / 0.0182 | all 0.0 | 0.091 / 0.182 / 0.0182 | 2,821 |
| `mistralai/devstral-2512` | 0.40 / 2.00 / 0.04 | all 0.0 | 0.40 / 2.00 / 0.04 | 13,000 |

`typesafe/jev-1.13` (the classifier) has no `prices.toml` row; the catalogue lists the JEV router with dynamic pricing (`-1`), so no fixed rate exists. Classifier cost comes from the reported `usage.cost`.

## Finding: the ladder is inverted by price

By these prices `high` (430) is about 11x cheaper than `mid` (4,800 peak) and 22x cheaper than `low` (9,600) for a 30k in / 500 out request. Every tier is cheaper than the one below it. The ladder was not reordered: the order follows the DeepSWE quality ranking in `autoroute.toml`, and whether to keep it, reorder it, or swap models is the owner's decision. Until then, "routing a request to a lower tier" saves nothing and "escalating" lowers the bill.

Consequences already handled in code: over-budget requests now route to the cheapest tier by this table (here `high`), and Octo logs a startup warning while the ladder is not monotonic in price.

## Not verified

No OpenRouter key was available. Real cache hit rates, provider affinity, minimum cacheable length, and actual billed cost were not measured; the catalogue prices are list prices and the mid model's time-of-day pricing means the estimate can be 2x high off-peak.
