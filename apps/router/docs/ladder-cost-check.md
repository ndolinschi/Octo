# Ladder cost check (2026-11-10, low price updated 2026-11-11, re-fetched 2026-11-14)

## 2026-11-14: re-fetched, and the router now refreshes prices itself

Finding F5 (the owner's re-tests: the table lagged the catalogue; low output 0.567 vs 0.2028, high input 0.006 vs 0.038;
reported cost 0.31x the table) is addressed by the catalogue refresh ([prices.md](./prices.md)): the router fetches
`GET https://openrouter.ai/api/v1/models` at start and every 6 h and prices from it, with `prices.toml` as the fallback and
for `source = "manual"` overrides. The agent fetched the catalogue on 2026-11-14 (unauthenticated, 471 models listed, 463
priced) and copied the shipped rows from it:

| Model | Tier | Catalogue 2026-11-14 in / cache read / out | `prices.toml` before | 30k in / 500 out (micro-USD) |
| --- | --- | --- | --- | --- |
| `deepseek/deepseek-v4.1-flash` | low | 0.0507 / 0.001014 / 0.2028 | 0.051 / 0.018 / 0.567 | 1,813 -> 1,622 |
| `minimax/minimax-m3.1-flash` | mid | peak 0.15 / 0.015 / 0.60; base (off-peak UTC 15:00-01:00) 0.075 / 0.0075 / 0.30 | unchanged (peak kept) | 4,800 |
| `deepseek/deepseek-v4.1-flash-1017` | high | 0.038 / 0.01 / 0.50 | 0.006 / 0.005 / 0.50 | 430 -> 1,390 |
| `deepseek/deepseek-v4-flash` | (other) | 0.09 / 0.018 / 0.18 | 0.091 / 0.0182 / 0.182 | |
| `qwen/qwen3.7-flash` | (other) | 0.03 / 0.006 / 0.13, cache write 0.038 (0.10 / 0.40 from 32k prompt tokens) | cache write 0.0 | |

The other rows matched. The owner's catalogue figures were right on both counts (low output 0.2028, high input 0.038).
The ladder is **still inverted** but less so: `high` (1,390) is cheaper than `low` (1,622) and `mid` (4,800) for the
30k / 500 shape, so the price rule still serves low and mid requests at `high`. The router logs the three costs on every
refresh (`ladder = ...`) and warns when a refresh changes what the rule serves.

The sections below are the earlier checks, kept for provenance.

Comparison of `config/prices.toml` against the public OpenRouter catalogue (`GET https://openrouter.ai/api/v1/models`, unauthenticated, fetched 2026-11-10). Prices are USD per 1M tokens. The "30k in / 500 out" column is `30000 * input + 500 * output` in micro-USD, ignoring cache.

## Ladder models (`config/autoroute.toml`)

| Model | Tier | Catalogue in / out / cache read | `prices.toml` before | `prices.toml` after | 30k in / 500 out |
| --- | --- | --- | --- | --- | --- |
| `deepseek/deepseek-v4.1-flash` | low | 0.051 / 0.567 (owner-reported 2026-11-11); cache read 0.018 (owner-reported 2026-11-11) | 0.30 / 1.20 / 0.006 | 0.051 / 0.567 / 0.018 | before 9,600 ($0.0096) -> after 1,813 ($0.0018) |
| `minimax/minimax-m3.1-flash` | mid | peak 0.15 / 0.60 / 0.015; off-peak (UTC 15:00-01:00) 0.075 / 0.30 / 0.0075 | 0.15 / 0.60 / 0.015 | unchanged (peak rate kept) | 4,800 peak, 2,400 off-peak |
| `deepseek/deepseek-v4.1-flash-1017` | high | 0.006 / 0.50 / 0.005 | 0.006 / 0.50 / 0.005 | unchanged | 430 ($0.00043) |

The catalogue publishes no cache-write price for any of them; `cache_write` stays `0.0`.

**Cache read (2026-11-11).** The low model's `cache_read` is now 0.018 (owner-reported from the catalogue; it was 0.006). The 30k in / 500 out column ignores cache, so it does not change. With a cached prefix it does: for 30,000 input tokens of which 24,000 are cache reads plus 500 out, the estimate is 6,000 x 0.051 + 24,000 x 0.018 + 500 x 0.567 = 306 + 432 + 283.5 = about 1,022 micro-USD (was 306 + 144 + 283.5 = about 734). The low-vs-high order in the finding below is unchanged (high is 430 without cache).

**Correction (2026-11-11).** The 2026-11-10 version of this page recorded 0.30 / 1.20 for the low model as the catalogue figure and 0.051 / 0.567 as the stale repo value. The owner, measuring the ladder live, reported the opposite: the catalogue says 0.051 input / 0.567 output (USD per million tokens) and `prices.toml` was stale at 0.30 / 1.20. `prices.toml` now carries the owner-reported figures (comment dated 2026-11-11); the cache fields were left as they were. This was not re-fetched from the catalogue by the agent that made the change (see "Not verified").

## Other rows in `prices.toml` (not in the ladder)

The Mistral rows were replaced on 2026-11-13 with cheap non-Mistral tool-calling models of the same size class (the owner no longer uses Mistral).

| Model | Catalogue in / out / cache read | Before | After | 30k in / 500 out |
| --- | --- | --- | --- | --- |
| `meta-llama/llama-3.1-8b-instruct` | 0.02 / 0.04 / none (2026-11-13) | new row | 0.02 / 0.04 / 0.0 | 620 |
| `qwen/qwen3.7-flash` | 0.03 / 0.13 / 0.006 (2026-11-13) | new row | 0.03 / 0.13 / 0.006 | 965 |
| `qwen/qwen3-32b` | 0.08 / 0.28 / none (2026-11-13) | new row | 0.08 / 0.28 / 0.0 | 2,540 |
| `google/gemma-4-26b-a4b-it` | 0.0675 / 0.225 / 0.0375 (2026-11-13) | new row | 0.0675 / 0.225 / 0.0375 | 2,138 |
| `deepseek/deepseek-v4-flash` | 0.091 / 0.182 / 0.0182 | all 0.0 | 0.091 / 0.182 / 0.0182 | 2,821 |
| `qwen/qwen3-coder-next` | 0.12 / 0.80 / 0.07 (2026-11-13) | new row | 0.12 / 0.80 / 0.07 | 4,000 |

`typesafe/jev-1.13` (the classifier) has no `prices.toml` row; the catalogue lists the JEV router with dynamic pricing (`-1`), so no fixed rate exists. Classifier cost comes from the reported `usage.cost`.

## Finding: the ladder is inverted by price

By these prices `high` (430) is about 11x cheaper than `mid` (4,800 peak) and about 4.2x cheaper than `low` (1,813) for a 30k in / 500 out request. Every tier is still cheaper than the one below it (with the earlier 0.30 / 1.20 low price the gap was 22x; the owner's live measurement of $0.0096 / $0.0048 / $0.00043 matches those older numbers, so the live run and the corrected price table disagree for `low`, see "Not verified"). The ladder was not reordered: the order follows the DeepSWE quality ranking in `autoroute.toml`.

Consequences handled in code: over-budget requests route to the cheapest tier by this table (here `high`), and the owner decided the policy **never pay more for less**: with `never_pay_more_for_less = true` (default) a request decided for `low` or `mid` is served by the cheapest priced tier at or above it, here `high`; see [autoroute.md](./autoroute.md#price-rule-never-pay-more-for-less). Octo logs a startup warning while the ladder is not monotonic in price, followed by a line saying the rule is on and which tiers it swaps (or that it is off).

## Not verified

The corrected low price was not re-fetched from the catalogue; it is the owner's figure. The owner's live costs ($0.0096 for `low`) match the old 0.30 / 1.20 price, not the corrected one, so one of the two is wrong; check it against a real billed call. No OpenRouter key was available. Real cache hit rates, provider affinity, minimum cacheable length, and actual billed cost were not measured; the catalogue prices are list prices and the mid model's time-of-day pricing means the estimate can be 2x high off-peak.
