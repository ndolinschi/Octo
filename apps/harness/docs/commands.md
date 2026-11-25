# Project commands and working processes (harness)

The **Processes** workspace tab (`tool:processes`). A project has named shell commands ("Dev server", "Tests"), ad-hoc user processes, and harness-managed worker subprocesses (language servers and ACP agent CLIs); the user inspects output, stops (`SIGTERM`), force-kills (`SIGKILL`), or restarts them. Client types: `@octo/agent-client` (`commands.ts`; every `Bridge` member is optional, HTTP bridge and demo).

Code: `internal/projcfg` (the `Command` shape and its validation), `internal/project/settings.go` (the project field), `internal/commands` (`commands.go`, `manage.go`, `suggestions.go`), `internal/bridge/commands.go` and `internal/bridge/processes.go` (routes), `internal/lsp` (`ListProject`, `Restart`, 16 KiB `StderrTail`), `internal/orchestrator/processes.go` (`WorkerProcesses`, `StopWorkerProcess`), `internal/projectstore/command_runs.go` (run history).

## Safety (tested)

1. **Only the user starts a run.** The only ways are `POST …/commands/{name}/run`, `POST …/runs` (ad-hoc), and `POST …/runs/{rid}/restart`. No agent-side package imports `internal/commands` (`go list -deps` over every agent-side package), the tool list an ACP orchestrator sees over MCP has no command tool, and the MCP endpoint has no `commands`/`runs`/`processes` routes. Remote access denies `POST /v1/projects/*/runs` and all `/v1/projects/*/processes` routes (`ClassDeny`).
2. **No approval.** A run is the user's own action: in a `supervised` project it does not create an approval card (tested). The bridge's API token still protects the route like every other `/v1` route.
3. **Environment.** `bash -c <command>` with the shell tool's rules: the allow-listed environment of `internal/childenv` (no provider keys, no `*TOKEN*`/`*SECRET*`/`*PASSWORD*` variables; tested), no stdin. Not sandboxed, like the shell tool.

## The `commands` field

`Project.commands: [{ name, command, cwd?, pinned? }]`, `[]` when none; set with `POST /v1/projects` or `PATCH /v1/projects/{pid}`; a patch that carries `commands` replaces the list, one without leaves it. Stored in the project's settings table (`project_settings`, schema 8). Validation (400 `invalid_request`): at most 50; `name` 1-60 characters after trimming, no `/`, `\` or control characters, unique case-insensitively; `command` non-empty, at most 4096 bytes, no NUL; `cwd` empty, a project folder's label, or a relative path that does not leave the folder (no absolute path, no `..`); at most two `pinned`.

`cwd` resolves like this. Run in the project: empty = the first folder; a folder label = that folder; otherwise a path under the first folder (400 `invalid_cwd` when it does not exist, is not a directory, or a symlink leaves the folder). Run in a review: the review's worktree; its folder's label or empty = the worktree root; a path = under the worktree.

## API

All under `/v1/projects/{pid}`. Errors: `{ "error": { "code", "message" } }`.

| Method | Path | Body / query → response |
| --- | --- | --- |
| GET | `/commands/suggestions` | `{ suggestions: [{ name, command, cwd, source: "package.json"\|"Makefile"\|"justfile", configured }] }` |
| POST | `/commands/{name}/run` | `{ review_id? }` (body may be empty) → 201 `{ run_id, run: Run }` |
| POST | `/runs` | `{ command, name?, cwd? }` → 201 `{ run_id, run: Run }` (ad-hoc process in project folder) |
| GET | `/runs?review_id=&limit=` | `{ runs: Run[] }` newest first, no tails (default 100) |
| GET | `/runs/{rid}` | `Run` with `tail` |
| POST | `/runs/{rid}/stop?force=` | `{ force?: boolean }` → `Run` once it has ended (`force=1`/`true` sends immediate `SIGKILL`) |
| POST | `/runs/{rid}/restart` | Stops `rid` if still running, then spawns a fresh run with the same `name`, `command`, `cwd`, `review_id` → 201 `{ run_id, run: Run }` |
| GET | `/processes` | `{ processes: WorkerProcess[] }` — active interactive PTY terminals (`term:<id>`), language servers (`lsp:<id>`), and ACP agent subprocesses (`acp:<session_id>`) |
| POST | `/processes/{procid}/stop` | Stops/kills a worker subprocess → 204 No Content |
| POST | `/processes/{procid}/restart` | Restarts a worker subprocess → `{ process: WorkerProcess \| null }` |
| POST | `/terminals` | `{ folder?, cols?, rows? }` → 201 `{ session_id, folder, cwd, shell, pid }` (spawns an interactive PTY shell in the chosen project folder; denied on Remote access) |
| GET | `/terminals/{tid}/events` | SSE stream (`?token=` supported for `EventSource`) emitting `output` (`{ data: "<base64>" }`) and `exit` (`{ code, reason? }`) |
| POST | `/terminals/{tid}/input` | `{ data }` (up to 64 KiB) → 202 Accepted |
| POST | `/terminals/{tid}/resize` | `{ cols, rows }` → 204 No Content |
| DELETE | `/terminals/{tid}` | Closes the PTY session and terminates its process group → 204 No Content (`DELETE /v1/projects/{pid}` also closes all open PTY terminals for `{pid}`; `?force=1` stops active turns/sessions first and removes projects even when `project.sqlite` or read-only cache directories fail normal open/remove) |

`{name}` matches case-insensitively and must be URL-encoded. Errors: 404 `command_not_found`, `review_not_found`, `not_found` (project, run, terminal, or worker process), `terminal_closed`; 400 `invalid_cwd`, `unknown_folder`, `no_folder`, `invalid_request`; 409 `too_many_runs` (4 at once per project), `terminal_already_subscribed`, `review_closed`, `worktree_missing`, `no_folder`, `start_failed`; 429 `too_many_terminals` (8 per project).

```text
Run            { id, name, command, cwd (absolute), review_id?, pid? (OS PID while running),
                 status: "running"|"finished"|"stopped"|"error", exit_code: number|null,
                 started_at, finished_at?, duration_ms, output_bytes, truncated, tail? }
WorkerProcess  { id, kind: "lsp"|"agent"|"terminal", name, command, cwd?, pid, status: "running"|"busy"|"idle",
                 started_at, detail?, output?, session_id? }
```

`session_id` (kind `agent` only, 2026-11-18): the project session the ACP worker serves, so the Processes tab can say who
started it; runs and terminals are always the user's, a language server is the editor's. Test:
`internal/bridge/processes_test.go`.

`exit_code` is null while running and -1 when a signal ended the process. `pid` is populated only while `status == "running"` and cleared once finished. `finished`: the process ended by itself (any exit code); `stopped`: the user's Stop or Kill; `error`: it could not run, or the harness stopped while it ran (settled at start by `Recover`, or when read). The last 50 finished runs are kept per project.

## Events

| Event | Payload |
| --- | --- |
| `command.started` | `{ run: Run }` |
| `command.output` | `{ run_id, stream: "stdout"\|"stderr", text }` |
| `command.finished` | `{ run_id, exit_code, duration_ms, status, name, review_id? }` |

Output is sent in chunks of at most 16 KiB cut at character boundaries (invalid bytes become U+FFFD), at most every 50 ms per run, so a chatty command cannot flood the event stream. A run's output is capped at **5 MB** (stdout and stderr together): at the cap the text `\n[output truncated: the 5 MB limit was reached; the rest was dropped]\n` is sent as the last stdout chunk, `truncated` is true, and the rest is read and dropped (the process is not blocked). The kept `tail` is the last 64 KiB in arrival order. Stderr and stdout are separate pipes, so their relative order across the two streams is approximate.

**Stop** sends SIGTERM to the process group (`Setpgid`; children die with it), waits 3 s, then SIGKILL. **Kill** (`?force=1` or `{"force":true}`) sends SIGKILL to the process group immediately without waiting. On Windows there are no process groups: the process itself is killed. A run is also killed when the harness shuts down.

## Suggestions

Read from the top level of each project folder, never run: `package.json` `scripts` (in file order; names with shell-special characters are left out; run as `pnpm run` / `yarn` / `bun run` / `npm run` by the lock file), `Makefile`/`makefile`/`GNUmakefile` explicit targets (no pattern rules, special targets or recipes' lines; `make <t>`), `justfile`/`Justfile`/`.justfile` public recipes that need no argument (`just <r>`). At most 100; `configured` says a command of that name exists. `cwd` is the folder's label. Files over 1 MB are not read.

## In a review

`POST …/commands/{name}/run { review_id }` runs in that review's worktree. The review's `meta.runs` lists them, newest first, at most 20: `[{ id, name, status, exit_code, started_at, finished_at? }]` (read from the run history when the review is read).

## Not verified here

Windows (no bash; process groups), a command that detaches a daemon out of the process group, very long single lines of output, and real dev servers.
