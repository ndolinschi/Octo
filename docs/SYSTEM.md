# Octo at run time

For someone who operates or debugs Octo: what starts in which order, what happens when a part is missing, the HTTP + SSE
API by area, where the data is, what runs in the background, the limits, and where to look when something goes wrong.
The parts, flows and module map are in [`ARCHITECTURE.md`](ARCHITECTURE.md); this page does not repeat them.

Written on 2026-11-22 from the code (`apps/harness/cmd/harness/serve.go`, `apps/desktop/src-tauri/sidecar/src/bridge.rs`,
`apps/router/src/proxy/mod.rs` and the packages they call). Timings and caps are the constants in the code; the file is
named beside each. Only Linux was run.

Contents: [Start-up](#start-up) · [Shutdown](#shutdown) · [Failure modes](#failure-modes) · [API surface](#api-surface) ·
[Event stream](#event-stream) · [Data model](#data-model) · [Background work](#background-work) ·
[Limits](#limits-and-caps) · [Diagnostics](#diagnostics) · [Where to look](#where-to-look-when)

## Start-up

### The desktop app (`octo-sidecar`, `bridge.rs`)

| Step | What happens | Bound | On failure |
| --- | --- | --- | --- |
| 1 | `OCTO_BRIDGE_URL` set: start nothing, use that harness (and `OCTO_BRIDGE_TOKEN`) | – | A malformed URL is an error, not a fallback |
| 2 | Find the bundled `harness` (or `OCTO_HARNESS_BIN`); create `<app data>/harness` | – | "The bundled harness is missing at ..." on the start screen |
| 3 | Read the three `OCTO_ROUTER_*` keys of `harness.env` | – | A malformed file reads as "router off" |
| 4 | Router wanted (`OCTO_ROUTER_ENABLED=1` and an upstream key; not when `OCTO_ROUTER_BASE_URL` names an external one): free loopback port, config fragments under `<app data>/router/config`, a random client key, spawn `octo` with `OCTO_CONFIG` and `OCTO_EXIT_ON_STDIN_CLOSE=1`, wait for `GET /health` | 20 s (`ROUTER_HEALTH_TIMEOUT`) | The harness starts without the router; `bridge_notices()` returns `router_failed` and the UI shows one quiet line with the log tail and Retry |
| 5 | Login-shell environment: one `$SHELL -ilc` run for `PATH` and the allow-listed names | 3 s | The old fallback `PATH` and nothing else |
| 6 | Harness: free loopback port, a new 256-bit API token (`HARNESS_API_TOKEN`, environment only), `HARNESS_EXIT_ON_STDIN_CLOSE=1`, `--data-dir <app data>/harness`, `--base-url http://127.0.0.1:<router>/autoroute` when the router runs, `HARNESS_REMOTE_WEB_DIR` = the bundled phone client | – | – |
| 7 | Wait for the harness's `GET /health` (polled every 100 ms) | 15 s (`health::DEFAULT_TIMEOUT`) | The process is stopped; the webview's start screen shows the message, the last 20 log lines and Retry (`HostStatus.tsx`). A harness that exits early fails at once with its output in the log |
| 8 | The webview asks `bridge_url` for `{ url, token }` and connects | – | – |

A leftover from a crashed run is found by `harness.pid` / `router.pid` and stopped before a new start.

### The harness (`harness serve`, `serve.go`)

1. Flags, then `{data-dir}/harness.env` for names the process environment lacks; the log is wrapped in the diagnostics
   ring (200 records).
2. **Data folder lock** (`internal/datalock`, `harness.lock`). A second harness on the same folder stops with
   `data_dir_in_use`; a folder it cannot write stops with `data_dir_unwritable`.
3. **Leftover children**: every pid in `children.json` whose start time still matches is stopped (a killed harness left it).
4. **Store**: `registry.sqlite` opens (`registry_unavailable` stops the start; the file is left untouched); file modes are
   tightened.
5. API token (`HARNESS_API_TOKEN`, else generated into `{data-dir}/api-token`); remote tools (`--remote`); `prices.toml`
   (ignored with a warning when malformed).
6. **Router detection**: `GET {base-url origin}/health` (2 s). `"service":"octo"` turns the integration on and records its
   capabilities (`autoroute`, `route_hints`, `result_headers`, `budget_key`, `route_api`, `route_outcome`). A failed probe
   is retried in the background at most once a minute.
7. Event hub, providers service, feature flags, orchestrator, project service. Default models that name a missing ACP
   agent are ignored with a warning (the app still starts so the setting can be fixed).
8. **Recovery** of every project (`project.Service.Recover`): agents left running become `failed` ("interrupted"), an open
   turn is closed from its checkpoint (`partials`), the exchange is recorded `interrupted`, change diffs older than 30
   days are pruned. A project whose database cannot open is kept in the list as `status: "unavailable"`.
9. Language-server, terminal, review (sweep now and every 6 h) and command managers; the listener (a non-loopback
   `--addr` logs a warning; `/v1` still needs the token); browser proxy and settings managers; remote access (off).
10. Serve. The providers picture is re-read every 15 s (`providersWatchEvery`). `GET /health` answers from here on.

### The router (`octo`)

Config fragments from `OCTO_CONFIG` (embedded defaults for `openrouter.toml`, `autoroute.toml`, `prices.toml`); a non-loopback
`bind_addr` without `allow_remote` and `client_auth_key` is refused; the history database connects and migrates (on failure
the proxy serves without history); the price catalogue refresh starts when upstream is openrouter.ai; then it serves.

## Shutdown

| Trigger | Harness | Router |
| --- | --- | --- |
| SIGTERM / SIGINT, or EOF on stdin when `--exit-on-stdin-close` / `OCTO_EXIT_ON_STDIN_CLOSE=1` | Remote access closes, in-flight requests are cancelled, then within 10 s: the orchestrator (turns cancelled; ACP agents get `session/cancel` and about 3 s, then their process group is killed), the browser proxy, language servers, terminals (SIGHUP/SIGTERM/SIGCONT, SIGKILL after 2 s), the HTTP server; then the store closes and the lock is released | Graceful drain: in-flight history inserts finish (bounded queue) |
| The desktop app quits | The shell stops the harness's process group (SIGTERM, 3 s, SIGKILL), then the router's | (same) |
| The app is killed | Each sidecar sees EOF on the stdin the shell held and shuts down as above; terminals and runs it could not stop are stopped at the next start (`children.json`) | (same) |

## Failure modes

| Situation | What the person sees | Where it is decided |
| --- | --- | --- |
| Router switched off, or not detected | Everything works; no hints, no route decisions (`tier: auto` falls back to balanced), spend from usage rows | `internal/router` (detection), `orchestrator/auto.go` |
| Router failed to start in the app | A quiet notice line with Details and Retry; the harness runs without it | `octo-sidecar` `bridge.rs`, `apps/desktop/src/HostNotice.tsx` |
| Router stops while the harness runs | The turn fails with `router_unreachable` ("The Octo router stopped answering.", Retry) | `internal/usererr/catalogue_service.go` |
| Route call slow or failing | Never fails the turn: after 2500 ms (`HARNESS_ROUTE_TIMEOUT`), a 5xx, 422 or unknown choice, the balanced tier; a 402 is the budget failure | `orchestrator/auto.go` |
| Outcome report cannot be delivered | Nothing visible; up to 3 tries (3 s each, from 500 ms back-off), then dropped | `internal/router/outcome.go` |
| No API key, no Octo key, no custom base URL | The built-in loop is unavailable; ACP agents still work; such a turn fails at once with one message | `cmd/harness/serve.go` (`builtinReason`) |
| Model unreachable mid-answer | `model_unreachable` with Retry; the streamed text is kept as a `stopped` message | `internal/usererr`, `internal/agent` |
| API key refused | `api_key_rejected`, button "Connect provider" | `internal/usererr` |
| Ollama or a loopback gateway not running | The provider reads `not_running`; "Check again" re-probes (`POST /v1/providers/{id}/recheck`) | `internal/providers` |
| ACP agent missing or logged out | The turn ends with the agent's install or login hint (`hint` on `turn.finished`) | `internal/acp`, `internal/plugins` |
| An agent's plan limit is reached | The turn ends with `agent_limit_reached` ("<Agent> · <Account> has reached its usage limit.", action `switch_account`); the user picks another account or model and the request is sent again; nothing switches by itself. A limit the CLI reports as plain answer text is not caught | `orchestrator/acp_limits.go`, `internal/usererr/catalogue_accounts.go` |
| The accounts file cannot be read or does not parse | Logged; the harness starts without the extra accounts (every agent works as its own login) and the file is replaced on the next change | `internal/accounts` |
| A project database cannot be opened or is damaged | The project stays in the list as unavailable (`project_unavailable`) and names the `.pre-*` backups when there are some; the file is left untouched | `projectstore/unavailable.go` |
| A project folder is missing | `folder_missing`: the project opens; tools and files on that folder refuse with the path | `internal/usererr/catalogue_ops.go` |
| The registry cannot be opened | The harness does not start (`registry_unavailable`); the shell shows the message and the log tail | `serve.go` |
| Second harness on one data folder | It stops with `data_dir_in_use` | `internal/datalock` |
| The SSE stream drops | The client reconnects (EventSource plus a watchdog on missing heartbeats) and re-reads the project ([Event stream](#event-stream)) | `packages/agent-client/src/client.ts` |
| Budget reached | The turn ends `failed` with "Project budget reached ..."; no further upstream call | `orchestrator/route.go`, `internal/budget` |

Not verified: any of these on macOS or Windows; with a real tunnel; with a real Ollama.

## API surface

All routes are registered in `apps/harness/internal/bridge/bridge.go` (and `internal/remoteaccess` for `/v1/remote` and the
tunnel listener): 167 method + path pairs on 2026-11-22. Every `/v1` route needs `Authorization: Bearer <token>`; the SSE
routes (a project's events, a language-server session, a terminal, an agent login) also take `?token=`. Errors are catalogue bodies (`message`, `hint`, `command`, `action`, `details`;
[`errors.md`](../apps/harness/docs/errors.md)). The client methods are in `packages/agent-client/src/client.ts` and `rare.ts`.

| Area | Routes (`{pid}` = project, `{sid}` = session) | Exact shapes |
| --- | --- | --- |
| Service | `GET /health`, `/v1/config`, `/v1/diagnostics`, `/v1/limits`, `/v1/usage`, `/v1/search`, `/v1/plugins` | [architecture.md](../apps/harness/docs/architecture.md), [acp-orchestrator.md](../apps/harness/docs/acp-orchestrator.md) |
| Settings | `GET`/`PUT /v1/settings` (loopback peers and the UI's origins only) | [settings.md](../apps/harness/docs/settings.md) |
| Providers | `GET /v1/providers`; `PUT .../{id}/prefs`, `.../custom-models`; `POST .../recheck`, `.../refresh-models` | [providers.md](../apps/harness/docs/providers.md) |
| Agent accounts and logins (local only; not for a paired device) | `POST /v1/providers/{id}/accounts`, `DELETE .../accounts/{account}[?delete_folder=true]`; `PATCH /v1/providers/{id}/account`; `POST /v1/providers/{id}/login`, `GET .../login/{lid}/events` (SSE, also `?token=`), `POST .../login/{lid}/input`, `.../resize`, `DELETE .../login/{lid}` | [providers.md](../apps/harness/docs/providers.md#agent-accounts-2026-11-26) |
| Folders | `GET /v1/fs/dirs`, `/v1/fs/recent`; `POST /v1/fs/pick-folder` | [architecture.md](../apps/harness/docs/architecture.md) |
| Projects and the conversation | `GET`/`POST /v1/projects`; `GET`/`PATCH`/`DELETE /v1/projects/{pid}`; `agents`, `agents/{aid}`, `agents/{aid}/messages`; `POST messages`, `cancel`, `compact`, `clear`, `rewind`, `side` (+ `stop`, `GET`, `DELETE`), `complete`, `attachments`; `GET context`, `turns/{tid}/context`, `slash-commands`, `export`, `plans/latest`, `POST plans/{id}/approve` | [architecture.md](../apps/harness/docs/architecture.md), [parity.md](../apps/harness/docs/parity.md) |
| Sessions, workspaces, branches | `GET`/`DELETE /v1/sessions`, `/v1/sessions/importable`; per project `sessions` (list, create, import, get, patch, delete, `messages`, `stop`, `resume`, `default`, `clear`, `compact`, `rewind`, `context`, `export`, `plans/latest`, `queue...`, `worktree`), `workspaces`, `branches`, `branches/switch` | [sessions.md](../apps/harness/docs/sessions.md) |
| Changes, approvals, queue, forms, secrets (v7) | `changes`, `changes/{cid}`, `changes/{cid}/revert`; `approvals`, `approvals/{id}`, `approval-rules`; `queue` (list, clear, resume, edit, remove, `send-now`); `inputs`, `inputs/{id}`; `secrets`, `secrets/{name}` | [v7.md](../apps/harness/docs/v7.md) |
| Memory and notes | `memory`, `memory/{name...}`, `memory/search`, `memory/sessions`, `memory/exchanges/{eid}`; `tasks`, `facts`; `notes`, `notes/{nid}`, `notes/{nid}/export` | [memory.md](../apps/harness/docs/memory.md) |
| Files and language servers | `files`, `files/content` (GET, PUT); `lsp`, `lsp/{server}/sessions`, `lsp/sessions/{sid}/messages`, `.../events` (SSE), `DELETE` | [architecture.md](../apps/harness/docs/architecture.md#file-api), [language servers](../apps/harness/docs/architecture.md#language-servers) |
| Terminals, commands, processes | `terminals` (+ `input`, `resize`, `events` SSE, `DELETE`); `commands/{name}/run`, `commands/suggestions`; `runs` (list, start, get, `stop`, `restart`); `processes` (+ `stop`, `restart`) | [commands.md](../apps/harness/docs/commands.md) |
| Pull-request review | `prs`, `review/branches`, `reviews` (+ `checkout`, `files`, `files/{path...}`, `findings`, `threads`, `comments`, `submit-preview`, `submit`), `review-workspace` | [review.md](../apps/harness/docs/review.md) |
| Browser tab | `POST`/`DELETE browser/proxy` | [browser.md](../apps/harness/docs/browser.md) |
| Remote access (computer side) | `GET /v1/remote`; `POST enable`, `disable`, `check`, `pairing` (+ `DELETE`), `revoke-all`; `devices/{id}` (`PATCH`, `DELETE`, `confirm`) | [remote-access.md](../apps/harness/docs/remote-access.md) |
| Tunnel listener (phone side) | `GET /health`, `POST /pair/claim`, `GET /pair/me`, allow-listed `/v1/**`, `GET /v1/projects/{pid}/events/poll`, the web app | [remote-access.md](../apps/harness/docs/remote-access.md) |
| MCP for ACP orchestrators | `POST /mcp/v1/projects/{pid}` (loopback, per-session bearer token) | [acp-orchestrator.md](../apps/harness/docs/acp-orchestrator.md) |
| Events | `GET /v1/projects/{pid}/events` (SSE) | below |

Routes with no caller in `@octo/agent-client`, `@octo/ui`, `apps/web` or the scripts (found by matching every route against
their sources): only `GET /v1/projects/{pid}/notes/{nid}/export`, documented in `memory.md`.

The router's own routes (`apps/router/src/proxy/routes.rs`): `GET /health`; provider passthrough (`/v1/chat/completions`,
`/v1/messages`, `/v1/decisions` and aliases under `/openai`, `/openrouter`, `/claude`, `/anthropic`); `/autoroute/v1/messages`,
`/autoroute/v1/chat/completions`, `GET /autoroute/status`, `GET /autoroute/v1/calls/{request_id}`, `POST /autoroute/v1/route`,
`POST`/`GET /autoroute/v1/route/{request_id}/outcome`. Detail: [`apps/router/docs/proxy.md`](../apps/router/docs/proxy.md),
[`autoroute.md`](../apps/router/docs/autoroute.md).

## Event stream

- One hub per harness (`internal/events`), one stream per project. Every event carries `type` and `seq`, a per-project
  counter that starts at 1 for each harness process (it is in memory, not stored).
- The SSE route starts with `retry: 1000`, sends `event: heartbeat` every 15 s, and **does not replay**: `Last-Event-ID` is
  ignored. A subscriber that falls 2048 events behind is dropped (its channel is closed), which the client sees as a
  disconnect.
- About 50 event types; the list the client listens to is `BRIDGE_EVENT_TYPES` in `packages/agent-client`. The common
  ones: `message.delta`, `message.created`, `tool.started` / `updated` / `finished`, `agent.created` / `updated` /
  `activity` / `plan` / `compacted`, `turn.finished`, `queue.updated`, `approval.requested` / `resolved`,
  `input.requested` / `resolved`, `change.recorded`, `file.changed`, `session.*`, `project.updated`, `project.attention`,
  `providers.updated`, `settings.changed`, `memory.updated`, `task.updated`.
- **Reconnect**: `EventSource` retries itself; the client's watchdog also reopens a stream closed after an HTTP error and a
  half-open one (no heartbeat for `streamStaleMs`). On every reopen the UI (`packages/ui/src/state/project.tsx`, `syncAll`)
  re-reads the project, its agents, notes and sessions, and views that load their own lists (queue, approvals, forms)
  load them again. The reducer only folds; it never asks for anything.
- The phone has no SSE: `GET .../events/poll` long-polls (up to 25 s) and `apps/web/src/pollingEventSource.ts` presents it
  as an `EventSource`.

## Data model

### Harness: `registry.sqlite` and `project.sqlite`

`registry.sqlite` has one table, `projects`. Each `projects/{pid}/project.sqlite` has the tables below (39; created in
`projectstore/db.go` and the `migrate_v*.go` files). Each database uses WAL, a busy timeout and one pooled connection.

| Table | Holds | Since |
| --- | --- | --- |
| `project`, `folders`, `project_settings` | The project row, its folders, settings kept as JSON (commands, review, session settings) | 1, 8 |
| `agents`, `messages`, `partials`, `turn_alive` | Agent rows (orchestrators and sub-agents, route fields), their messages, streaming checkpoints, the running turn's heartbeat | 1, 2026-11-14 |
| `usage`, `compactions`, `context_receipts` | One row per model response or ACP usage update; compaction summaries; what a `window` request contained | Phase A, M2 |
| `acp_sessions` | Stored ACP session ids for `session/load` | S2 |
| `side_messages` | Side-question exchanges | 9 |
| `notes` | Project notes (Markdown with front matter) | 1, 10 |
| `tasks`, `memory_files`, `search_docs`, `search_u`, `search_t`, `search_s` | Task records and facts, memory files, the indexed documents and three FTS5 indexes | M1, 14 |
| `sessions`, `exchanges`, `session_reports` | Project sessions (memory sessions in 12, main and agent sessions from 13), their exchanges, reports to a parent session | 12, 13 |
| `workspaces`, `workspace_folders` | Git worktrees a session runs in | 15 |
| `session_declarations`, `file_claims`, `session_messages` | Coordination between parallel sessions (phase 4 of the parallel-sessions spec): created by schema 15, **only deleted from**; the tools that would fill them are not built | 15 |
| `queue` | Messages waiting for a session | v7 |
| `changes`, `blobs` | Recorded file changes and their diff contents | v7 |
| `approval_rules`, `plans` | "Always allow" rules; plans of plan mode | parity |
| `attachments` | Images attached to messages | 11 |
| `reviews`, `review_viewed`, `review_findings`, `review_comments`, `review_threads`, `command_runs` | Pull-request reviews; Processes runs | 6, 8 |

**Versions and migrations.** `PRAGMA user_version` is stamped with `projectstore.SchemaVersion` (**15**). An older database
is migrated when it opens; most steps are additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN` when missing). Two
migrations rewrite data and first copy the file with `VACUUM INTO`: schema 14 (memory M6) leaves `project.sqlite.pre-m6`,
schema 15 (parallel sessions) leaves `project.sqlite.pre-v15` (numbered names when one exists). **Nothing deletes them.** A
database newer than the binary is refused untouched. Delete the backups by hand, with the harness stopped, once the
migrated project works.

### Harness: agent accounts (2026-11-26)

Two things in the data folder belong to accounts of agents ([providers.md](../apps/harness/docs/providers.md#agent-accounts-2026-11-26)).
`agent-accounts.json` (file `0600`, written by temp file and rename) holds the names, short ids and folders of the extra
accounts, whether Octo created each folder (`owned`), and the names given to agents' own logins (`default_labels`); no
secret. Each account's folder is the one given when it was added (the UI suggests one beside the agent's own, such as
`~/.claude-work`); Octo creates it (`0700`) when it is missing. The CLI writes its own login there and Octo never reads it.
Octo deletes a folder only when the account is removed with "Also delete its login folder" and Octo created it; the CLI's
keychain entry, if it made one, is never removed.
The project database only stores model strings such as `acp:claude-code@work/opus`; it has no account table and no
migration was needed.

### Router: `history.sqlite`

| Table | Holds | Retention |
| --- | --- | --- |
| `calls` | One row per proxied call: provider, model, status, latency, tokens, cost in micro-dollars, capped payloads (unless `store_payloads = false`) | not pruned by age (the `calls_max_*` settings apply to `autoroute_calls`) |
| `decisions` | Decisions classifier calls and scores | not pruned |
| `session_outcomes` | Test summaries parsed from tool results, per session | not pruned |
| `autoroute_calls`, `budget_spend` | Call records behind `GET /autoroute/v1/calls/{id}`; spend per budget key | 30 days / 100,000 rows; 90 days; pruned every 600 s (`config/history.toml`) |
| `delegations`, `delegation_outcomes` | One row per route decision; append-only outcome reports; the cached `solved` label | **never pruned** (the training set); `octo export-delegations` writes them as JSON lines |

Migrations: 14 files in `apps/router/migrations/`, applied at connect by sqlx; the offline query cache is
`apps/router/.sqlx/`. Detail: [`apps/router/docs/history.md`](../apps/router/docs/history.md).

The only `DELETE` statements in the router's history code are for `autoroute_calls` and `budget_spend`
(`apps/router/src/history/records.rs`): `calls`, `decisions`, `session_outcomes` and the delegation tables grow without
bound.

## Background work

| Work | Interval | Code |
| --- | --- | --- |
| Router re-probe while not detected | at most once a minute, when asked | `internal/router` |
| Providers picture refresh | every 15 s | `serve.go` `providersWatchEvery`, `internal/providers` |
| ACP login probes | at most once a minute per agent (15 s after a failure), 5 s timeout, never awaited by a request | `internal/plugins/probe.go` |
| Agent version checks | every 10 min, 5 s timeout | `internal/plugins/version.go` |
| Agent login poll (while a login command runs) | the login probe every 5 s until it says logged in, once more at exit; the command is stopped after 10 min | `internal/agentlogin` |
| Streaming checkpoint / running-turn stamp | at most every 500 ms / every 5 s | `projectstore/partials.go`, `orchestrator/orchestrator.go` |
| Idle ACP orchestrator sessions | shut down after 30 min (`HARNESS_ACP_IDLE`); side-question sessions after 15 min | `orchestrator/acp_host.go`, `side_acp.go` |
| Language-server sessions without a stream | ended after 30 s | `internal/lsp` |
| Idle terminals | closed after 5 min | `internal/terminal` |
| Unanswered approvals | denied after 30 min (`HARNESS_APPROVAL_TIMEOUT`) | `internal/approval` |
| Unreferenced attachments | deleted after 30 days; sweep daily | `orchestrator/attachments_gc.go` |
| Change diffs | pruned after 30 days, at start | `project/changes.go` |
| Review worktrees | swept at start and every 6 h; unused reviews lose their worktree after 14 days | `internal/review` |
| Remote devices | pending devices vanish after 5 min; devices unused for 30 days are removed; remote access turns itself off after 8 hours without a device request (`HARNESS_REMOTE_IDLE_OFF_HOURS`) | `internal/remoteaccess` |
| Router: call-record and spend pruning; price catalogue refresh | every 600 s; every 6 h | `apps/router/src/history`, `src/prices` |

## Limits and caps

| Limit | Value | Code |
| --- | --- | --- |
| JSON request body | 1 MiB (`maxBody`); a file write 3 MiB; an attachment 5 MiB | `internal/bridge` |
| A message in the composer | 1 MiB less a 4 KiB envelope; refused in the UI with "save it as a file" | `packages/ui/src/lib/composerInput.ts` |
| File read through the API | 2 MiB | `internal/files` |
| Tool result / sub-agent report / `read_file` lines | 48 KiB / 32 KiB / 2000 (environment overrides) | `internal/tools/cap.go` |
| `web_fetch` | 200,000 bytes | `tools/webfetch` |
| Loop iterations per agent | 25 (`HARNESS_MAX_TURNS`) | `internal/config` |
| Sub-agent depth | 3 by default, at most 8 | `internal/config` |
| Running sessions | 3 per project (`session_settings.max_running`, at most 8); 6 on the machine (`HARNESS_MAX_RUNNING_SESSIONS`, 1 to 32) | `projectstore/session_settings.go`, `internal/config` |
| Queue | 20 messages per session | `projectstore/queue.go` |
| Language servers | 8 live sessions per project; 4 MiB per message; 256 buffered messages | `internal/lsp` |
| Terminals | 12 per project; 64 KiB per input | `internal/terminal` |
| Agent logins | one per agent id (a new one closes the old); 10 min each; they count against the terminal manager's session limits | `internal/agentlogin` |
| Account name | 1 to 40 characters; slug at most 32 | `internal/accounts` |
| Command output | 5 MiB per run, 64 KiB tail kept | `internal/commands` |
| Memory file / form text / schema | 64 KiB / 16 KiB / 32 KiB | `internal/memory`, `internal/inputs` |
| ACP recap for a new session | 8000 characters, last 40 texts | `orchestrator/acp_orch.go` |
| Change pre-images | 256 MiB per project (`shadow/`); hashing up to 64 MiB per file | `internal/changes` |
| ACP wire trace | 5 MB per file, 20 files | `internal/acptrace` |
| Diagnostics log ring | 200 records | `internal/diag` |
| Desktop logs | 2 MiB per file, one `.1` kept | `octo-sidecar` `logfile` |
| `git` calls | 2 min | `internal/gitx` |
| Route call | 2500 ms | `HARNESS_ROUTE_TIMEOUT` |
| Router: request body | `[limits] max_body_bytes` (`config/limits.toml`) | `apps/router/src/proxy` |
| Router: upstream request | 600 s including streaming (`[upstream] request_timeout_secs`) | `config/upstream.toml` |
| Router: history inserts | 32 at once; a row waits 5 s for a slot, then is dropped (logged) | `apps/router/src/history` |

## Diagnostics

- **`harness doctor [--json] [--data-dir D]`** (`cmd/harness/doctor.go`, `internal/diag`): version, Go and OS, the data dir
  (the desktop app's when it exists and none is given), the `PATH` and login-shell names children get, the names (never
  values) of provider and router variables that are set, the built-in loop and router state, `cloudflared`, and per agent the
  resolved command, `requires`, the login probe (run now: exit status only) and the install and login hints.
- **`GET /v1/diagnostics`**: the same from the running harness without running probes, plus the last 200 log records with
  credentials scrubbed. Settings → Privacy and data → "Copy diagnostic report" in the UI.
- **Logs**: in the desktop app `harness.log` and `router.log` in the app's log folder; the start screen and the router notice
  show their tails. Standalone: standard error (`RUST_LOG` for the router).
- **ACP wire trace**: `HARNESS_ACP_TRACE=1` (or the setting) writes `{data-dir}/traces/*.jsonl` for sessions that start
  afterwards, redacted ([acp-orchestrator.md](../apps/harness/docs/acp-orchestrator.md#diagnostics-and-the-wire-trace)).
- **Router**: `GET /health` (version and capabilities), `GET /autoroute/status[?session=]`, `GET /autoroute/v1/calls/{id}`,
  `GET /autoroute/v1/route/{id}/outcome`, and the history database (`scripts/reconcile_costs.py` for costs).
- **Versions**: `harness --version`, `octo --version`; `GET /health` of the harness also names the router's version while
  one is detected.

## Where to look when

| Symptom | Look at first | Then |
| --- | --- | --- |
| The app shows "Starting Octo..." and then an error | The log tail on that screen (`harness.log`) | `data_dir_in_use`: another harness on the folder; `registry_unavailable`: the registry file; `harness doctor` |
| "Router could not start" line | Details (the `router.log` tail) | The upstream key in Settings → Providers; `router.log`; run `octo --version` from the app folder |
| A turn fails with no model call | The turn's message and hint | No key: Settings → Providers; budget reached: the project's budget; `GET /v1/providers` |
| An ACP agent turn fails | The hint on the failed turn | `harness doctor` (command, login probe); the wire trace; [acp-orchestrator.md](../apps/harness/docs/acp-orchestrator.md) |
| A second account is not logged in, or the Log in button fails | `harness doctor` (each account, its folder and probe); the command shown under the login sheet, run in a terminal | [providers.md](../apps/harness/docs/providers.md#agent-accounts-2026-11-26) |
| The UI shows stale state after a sleep or network change | The live indicator (connecting / reconnecting) | The SSE route with curl and the token; `GET /health`; the reconnect watchdog in `client.ts` |
| A project is greyed out as unavailable | Its error and `details` | The `project.sqlite` path and its `.pre-*` backups; file permissions |
| `folder_missing` | The folder path in `details` | Re-attach or remove the folder in the project's settings |
| Costs look wrong | Usage tab and `GET /v1/usage?group=model` | The router's call record (`GET /autoroute/v1/calls/{id}`); `prices.toml` of each side; `reconcile_costs.py` |
| `tier: auto` never picks an agent | The agent row's `route_reason` | `GET /health` of the router (`route_api`); `models.auto_candidates`; the agents' login state |
| An approval never appears on the phone | The device's state in Settings → Remote access | The allow-list (`internal/remoteaccess/rules.go`); `e2e-remote.sh` |
| A file change cannot be reverted | The revert's error (`file_changed`) | The file changed since; the Changes tab's diff |
| Tests or scripts collide on ports | The script's header | `E2E_*` / `OCTO_DEV_*` port variables ([ARCHITECTURE.md](ARCHITECTURE.md#scripts)) |
| A language server or terminal keeps dying | The server's exit event | `internal/lsp` limits (8 sessions, 4 MiB, slow subscriber); the plugin manifest's command |
