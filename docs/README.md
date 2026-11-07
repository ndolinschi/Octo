# Octo documentation

Canonical product docs for the Octo proxy. Operational agent notes stay in [`AGENTS.md`](../AGENTS.md); this tree explains **how the system works**, **what is reliable today**, and **what is not**.

| Doc | Contents |
| --- | --- |
| [overview.md](./overview.md) | What Octo is, who it is for, capabilities at a glance |
| [architecture.md](./architecture.md) | Layers, runtime shape, module map, diagrams |
| [proxy.md](./proxy.md) | Passthrough routes, provider selection, streaming, auth |
| [autoroute.md](./autoroute.md) | Model ladder, decide pipeline, shaping, retries, compact |
| [history.md](./history.md) | SQLite history, cost accounting, observe, outcomes |
| [configuration.md](./configuration.md) | `config/*.toml` reference and env overrides |
| [status.md](./status.md) | **Works / partial / missing** — honest capability matrix |

## Archive (evidence & design notes)

Dated investigations kept for provenance; prefer the guides above for day-to-day reading.

| Path | Kind |
| --- | --- |
| [verification/](./verification/) | Autoroute verification checklist (2026-11-06) |
| [experiments/](./experiments/) | Live session write-ups (e.g. ratelim vs taskq) |
| [debug/](./debug/) | Incident notes (text-as-tool-call, long sessions) |
| [research/](./research/) | Orchestration investigation |
| [plans/](./plans/) | Unshipped orchestration plan (P0–P4) |
| [superpowers/](./superpowers/) | Design notes / skill plans archived under docs |

Root shortcut: [`ARCHITECTURE.md`](../ARCHITECTURE.md) points at [architecture.md](./architecture.md) and this index.
