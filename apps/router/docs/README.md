# Octo documentation

Canonical product docs for the Octo proxy (`apps/router`). Operational agent notes stay in [`AGENTS.md`](../AGENTS.md); monorepo map in [`../../../AGENTS.md`](../../../AGENTS.md). This tree explains **how the system works**, **what is reliable today**, and **what is not**.

| Doc | Contents |
| --- | --- |
| [overview.md](./overview.md) | What Octo is, who it is for, capabilities at a glance |
| [architecture.md](./architecture.md) | Layers, runtime shape, module map, diagrams |
| [proxy.md](./proxy.md) | Passthrough routes, provider selection, streaming, auth |
| [autoroute.md](./autoroute.md) | Model ladder, decide pipeline, shaping, retries, compact, price rule, harness integration (headers, budget, calls), routing decision for delegation (`/autoroute/v1/route`) |
| [history.md](./history.md) | SQLite history, cost accounting, observe, outcomes, persisted call records and budget spend |
| [configuration.md](./configuration.md) | `config/*.toml` reference and env overrides (`OCTO_CONFIG`, `OCTO_HISTORY_TOKEN_KEY`, `OCTO_EXIT_ON_STDIN_CLOSE`) |
| [status.md](./status.md) | **Works / partial / missing** — honest capability matrix |
| [prices.md](./prices.md) | Live price table: catalogue refresh, `prices.toml` overrides and fallback, disk cache, `/health`, price source per call |
| [ladder-cost-check.md](./ladder-cost-check.md) | Ladder prices vs the OpenRouter catalogue (2026-11-10, re-fetched 2026-11-14) |

## Version and help

`octo --version` prints `octo 0.2.0` (`CARGO_PKG_VERSION`) and `octo --help` the usage; both exit 0 without reading the
config or starting the proxy (an unknown argument exits 2 with the usage). `GET /health` reports the same `version`, which the
harness passes on as `router_version`. The version is one number with the harness and the desktop app (0.2.0).

## Readable errors (2026-11-19)

- An upstream that fails answers 502 in the existing shape with a sentence that says what happened: `upstream request
  failed: <host> did not answer in time (after the router's retries); try again later, or raise
  upstream.request_timeout_secs`, `… could not connect to <host>; check that the provider is reachable and its base URL is
  right`, or `… the connection to <host> broke; try again` (the host only, never credentials).
- A budget reached through the request's `x-octo-budget-usd` header names that header ("raise it or start a new budget
  key") instead of the config keys; a configured budget still names `autoroute.session_budget_usd`.
- Not done: a truncated upstream SSE stream still ends as 200 without an error event (the stream relay has no hook for it
  yet; reported to the owner).

## Archive (evidence & design notes)

Dated investigations kept for provenance; prefer the guides above for day-to-day reading.

| Path | Kind |
| --- | --- |
| [verification/](./verification/) | Autoroute verification checklist (2026-11-06) |
| [experiments/](./experiments/) | Live session write-ups (e.g. ratelim vs taskq) |
| [debug/](./debug/) | Incident notes (text-as-tool-call, long sessions) |
| [research/](./research/) | Orchestration investigation |
| [plans/](./plans/) | Unshipped orchestration plan (P0–P4) |

Root shortcut: [`ARCHITECTURE.md`](../ARCHITECTURE.md) redirects here. How the router fits the whole system (harness, desktop shell, data locations): [`../../../docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md).
