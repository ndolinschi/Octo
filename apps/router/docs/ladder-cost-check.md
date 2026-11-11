# Ladder cost check (2026-11-10, low price updated 2026-11-11)

Comparison of `config/prices.toml` against the public OpenRouter catalogue (`GET https://openrouter.ai/api/v1/models`, unauthenticated, fetched 2026-11-10). Prices are USD per 1M tokens. The "30k in / 500 out" column is `30000 * input + 500 * output` in micro-USD, ignoring cache.

## Ladder models (`config/autoroute.toml`)

| Model | Tier | Catalogue in / out / cache read | `prices.toml` before | `prices.toml` after | 30k in / 500 out |
| --- | --- | --- | --- | --- | --- |
| `deepseek/deepseek-v4.1-flash` | low | 0.051 / 0.567 (owner-reported 2026-11-11); cache read 0.006 | 0.30 / 1.20 / 0.006 | 0.051 / 0.567 / 0.006 | before 9,600 ($0.0096) -> after 1,813 ($0.0018) |
| `minimax/minimax-m3.1-flash` | mid | peak 0.15 / 0.60 / 0.015; off-peak (UTC 15:00-01:00) 0.075 / 0.30 / 0.0075 | 0.15 / 0.60 / 0.015 | unchanged (peak rate kept) | 4,800 peak, 2,400 off-peak |
| `deepseek/deepseek-v4.1-flash-1017` | high | 0.006 / 0.50 / 0.005 | 0.006 / 0.50 / 0.005 | unchanged | 430 ($0.00043) |

The catalogue publishes no cache-write price for any of them; `cache_write` stays `0.0`.

**Correction (2026-11-11).** The 2026-11-10 version of this page recorded 0.30 / 1.20 for the low model as the catalogue figure and 0.051 / 0.567 as the stale repo value. The owner, measuring the ladder live, reported the opposite: the catalogue says 0.051 input / 0.567 output (USD per million tokens) and `prices.toml` was stale at 0.30 / 1.20. `prices.toml` now carries the owner-reported figures (comment dated 2026-11-11); the cache fields were left as they were. This was not re-fetched from the catalogue by the agent that made the change (see "Not verified").

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

By these prices `high` (430) is about 11x cheaper than `mid` (4,800 peak) and about 4.2x cheaper than `low` (1,813) for a 30k in / 500 out request. Every tier is still cheaper than the one below it (with the earlier 0.30 / 1.20 low price the gap was 22x; the owner's live measurement of $0.0096 / $0.0048 / $0.00043 matches those older numbers, so the live run and the corrected price table disagree for `low`, see "Not verified"). The ladder was not reordered: the order follows the DeepSWE quality ranking in `autoroute.toml`.

Consequences handled in code: over-budget requests route to the cheapest tier by this table (here `high`), and the owner decided the policy **never pay more for less**: with `never_pay_more_for_less = true` (default) a request decided for `low` or `mid` is served by the cheapest priced tier at or above it, here `high`; see [autoroute.md](./autoroute.md#price-rule-never-pay-more-for-less). Octo logs a startup warning while the ladder is not monotonic in price, followed by a line saying the rule is on and which tiers it swaps (or that it is off).

## Not verified

The corrected low price was not re-fetched from the catalogue; it is the owner's figure. The owner's live costs ($0.0096 for `low`) match the old 0.30 / 1.20 price, not the corrected one, so one of the two is wrong; check it against a real billed call. No OpenRouter key was available. Real cache hit rates, provider affinity, minimum cacheable length, and actual billed cost were not measured; the catalogue prices are list prices and the mid model's time-of-day pricing means the estimate can be 2x high off-peak.
