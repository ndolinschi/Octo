# Prices: catalogue refresh and `prices.toml`

The router prices calls (cost estimates, budget downgrade, the price rule `never_pay_more_for_less`) from one **live price
table**. Since 2026-11-14 it refreshes that table from the public OpenRouter catalogue itself; `config/prices.toml` stays as
the fallback and as the place for manual overrides. Background: the owner's finding F5 (the static table drifted from the
catalogue: low output 0.567 vs 0.2028, high input 0.006 vs 0.038).

Code: `src/prices/` (`catalogue.rs` parser, `source.rs` HTTP source behind the `CatalogueSource` trait, `cache.rs` disk
cache, `refresh.rs` the refresh loop, `mod.rs` mode, merge, `PriceBook`, `/health` object), `src/history/cost.rs`
(`PriceTable`, `PriceSource`, `LivePrices`). Tests: `tests/price_catalogue.rs`.

## Precedence (per model)

1. a `prices.toml` row marked `source = "manual"`;
2. the catalogue (under the model id and its `canonical_slug`; a manual row on either name blocks both);
3. a `prices.toml` row without the marker (`source = "fallback"` or no `source`): the **fallback**;
4. none (no estimate; the price rule treats the tier as unpriced).

Existing `prices.toml` files stay valid: every row without the marker is a fallback row. A catalogue row keeps the file
row's `billed_as`. With refresh off, or before the first catalogue arrives, the table is the manual and fallback rows.

```toml
[prices."vendor/model"]
source = "manual"      # always wins over the catalogue
input = 1.0
cache_read = 0.1
cache_write = 0.0
output = 2.0
```

## Settings (`[prices]` scalar keys in `prices.toml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `refresh` | *(auto)* | `"catalogue"` or `"off"`. Unset: on when every OpenRouter upstream URL (`messages_url`, `chat_completions_url`, `decisions_url`) is on `openrouter.ai`, off otherwise (a mock or proxy upstream, as in `scripts/dev.sh --router --mock` and `apps/harness/scripts/e2e-router.sh`) |
| `refresh_interval_secs` | `21600` (6 h) | Time between refreshes, jittered by ±10% (minimum 60 s) |
| `cache_file` | *(beside the history DB)* | Disk cache path; default `prices-catalogue.json` in the directory of `[history] database_path`; none for an in-memory database |

`OCTO_PRICES_REFRESH=off|catalogue` overrides `refresh` (any other non-empty value means off). An unknown `[prices]`
scalar key, an invalid `refresh` or an unknown `source` fails the config load.

## Fetch

`GET https://openrouter.ai/api/v1/models` with no credentials, no cookies, no attribution headers and the generic user
agent `octo-router/<version>`; nothing about the user or project is sent. Timeout 30 s (connect 10 s), body cap 16 MiB
(the response was about 0.85 MB / ~470 models on 2026-11-14). When a response carries an `ETag` the next fetch sends
`If-None-Match` and a `304` keeps the prices with a new `fetched_at` (the catalogue sent no `ETag` on 2026-11-14, so in
practice every refresh is a full fetch).

- **Start:** the disk cache, if any, is applied before the router serves; the first fetch then runs in the background.
  Requests are served with the table in hand (cache, else `prices.toml`) until it returns.
- **Interval:** after a success, the next fetch is `refresh_interval_secs` ±10% later.
- **Failure:** the table in use is kept; retries after 1, 2, 4, ... minutes, at most an hour and at most the interval.
  A body that does not parse, or lists no priced model, is a failure (it never empties the table).

## Parsing

`pricing` values are USD per **token** (strings, numbers accepted); they are multiplied by 1e6 (USD per 1M tokens) and
rounded to 1e-9. `prompt` -> `input`, `completion` -> `output`, `input_cache_read` -> `cache_read`,
`input_cache_write` -> `cache_write` (a missing cache price is 0). A model with a missing or unparsable `prompt` or
`completion` is skipped; a negative value (`"-1"`, dynamic pricing such as `typesafe/jev-router`, `openrouter/auto`) skips
the model. `overrides` entries with `utc_start`/`utc_end` (time-of-day pricing, e.g. `minimax/minimax-m3.1-flash`) raise
each rate to the highest window: the conservative estimate, as the static table did. Entries with `min_prompt_tokens`
(long-prompt pricing, e.g. `qwen/qwen3.7-flash` from 32k tokens) are ignored: the base rate is used. Free models (`0`/`0`)
are kept; a zero row never produces an estimate and counts as unpriced for the price rule.

The whole priced catalogue is kept (about 470 models, under 100 KB in memory, ~60 KB on disk), so any model seen in a
request is covered without tracking which ones were seen.

## Disk cache

`prices-catalogue.json` (`{"version":1,"fetched_at":<unix s>,"etag":...,"models":[{"id","canonical","input",
"cache_read","cache_write","output"}]}`), written through a temporary file and a rename after each successful fetch. A
restart without network applies it; when it is older than twice the interval a WARN says the cached prices are stale, and
`/health` shows `stale: true`. It is the router's own file, beside its own history database (not shared with the harness
or desktop).

## Observability

- **`GET /health`** has a `prices` object: `refresh` (`catalogue`/`off`), `reason` (env var, setting, or the upstream
  rule), `interval_secs`, `rows` (`manual` / `catalogue` / `fallback` slugs in the live table; catalogue slugs include
  canonical aliases), `catalogue` (`null` until one is loaded, else `fetched_at`, `age_secs`, `stale`, `models`,
  `from_cache`), `last_attempt_at`, `last_error`.
- **Log on refresh** (INFO `catalogue prices applied`): source (`catalogue` or `cache`), `fetched_at`, `models`,
  `updated` (models whose effective price changed), `added` (models that had no price), `biggest` (largest change by
  factor, e.g. `deepseek/deepseek-v4.1-flash cache_read 0.018 -> 0.001014`), and `ladder` (each tier's blended cost for the
  30k in / 500 out shape).
- **Per call:** `GET /autoroute/v1/calls/{id}` has `price_source` (`manual`, `catalogue@YYYY-MM-DD` or `fallback`) when the
  call had a table estimate, whether or not the estimate was the charged cost. The `calls` table of the history database
  is unchanged (no new column; its `cost_source` and `estimated_cost_micros` are as before).
- **Reconcile warning:** when the reported cost differs from the estimate by more than 25% (`estimate_ratio`), the WARN
  names the model, the ratio and the price source: `reported cost is 3.20x the price table (catalogue@2026-11-14) for
  <model>`; at most once per model per hour.

## The ladder and sticky sessions

`Tiers` and `History` hold the same `LivePrices` handle, not a copy: a refresh is seen by the next decision. Each price
comparison (`price_swap`, `cheapest_band`) reads one snapshot, so a refresh cannot change prices halfway through a
decision.

What a refresh changes mid-session: sessions remember the **decided** tier (`sticky_band`), never the served one, and a
refresh does not touch sessions. Sticky holds, escalation counters and `down_confirm` are unchanged. Only the tier the
price rule **serves** for the next request can change (it is computed per request, as it already is when the request
shape changes). So a session decided `low` and served `high` under one table is served `low` after a refresh that makes
`low` cheapest, still decided `low`, and goes back to `high` if the prices flip back. Switching the served model loses
that session's provider prompt cache once. When a refresh changes what the rule serves for the 30k/500 shape, a WARN
names the mapping before and after (`low->high, mid->high, high->high` -> `low->low, ...`) and the ladder warnings are
logged again. Test: `a_refresh_mid_session_keeps_the_sticky_tier_and_changes_only_the_served_model`.

Budget downgrade (`cheapest_band`) and `/autoroute/v1/route` cost estimates read the live table the same way.

## Tests and what they do not cover

`tests/price_catalogue.rs`: parser on a fixture trimmed from a real fetch (2026-11-14, `tests/fixtures/
openrouter_catalogue_2026-11-14.json`, plus two hand-written malformed entries), time-window and token overrides, bad
bodies; precedence and canonical aliases; the `prices.toml` schema; mode resolution (env, setting, upstream rule); `off`
mode starts nothing; cache round trip, default path, restart from a stale cache and `/health`; refresh with a fake source
(apply, save, conditional fetch, failure keeps prices, unparsable body changes nothing); backoff and jitter; requests
served while the first fetch hangs, then with the new prices; the tiers reading the live table; the mid-session refresh
above. No test reaches the network: the source is the `CatalogueSource` trait and tests inject a fake;
`tests/stdin_exit.rs` (the only test that runs the binary with the shipped OpenRouter URLs) sets `OCTO_PRICES_REFRESH=off`.

Verified live on 2026-11-14 (agent run, no key): the router binary with the shipped config fetched the catalogue at start
(463 priced models, 4 shipped rows changed), wrote `prices-catalogue.json` beside its history database and reported it in
`/health`. Not verified: a restart without network on a real machine, a 304 from the real catalogue (it sends no `ETag`),
and estimates against real billed costs (needs a key and live calls: the owner's run).
