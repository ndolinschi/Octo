# Project commands (harness)

UI decision 68 (`docs/superpowers/specs/2026-11-10-project-harness-ui.md`). A project has named shell commands ("Dev server", "Tests"); the user runs one, the output streams as events, Stop ends it. Client types: `@octo/agent-client` (`commands.ts`; every `Bridge` member is optional, HTTP bridge only).

Code: `internal/projcfg` (the `Command` shape and its validation), `internal/project/settings.go` (the project field), `internal/commands` (runner, suggestions), `internal/bridge/commands.go` (routes), `internal/projectstore/command_runs.go` (run history).

## Safety (tested)

1. **Only the user starts a run.** The only way is `POST …/commands/{name}/run`. No agent-side package imports `internal/commands` (`go list -deps` over every agent-side package), the tool list an ACP orchestrator sees over MCP has no command tool, and the MCP endpoint has no `commands`/`runs` routes. A test sets a command, runs an agent turn and asserts no run exists and the command's side effect did not happen.
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
| GET | `/runs?review_id=&limit=` | `{ runs: Run[] }` newest first, no tails (default 100) |
| GET | `/runs/{rid}` | `Run` with `tail` |
| POST | `/runs/{rid}/stop` | `Run` once it has ended (200; a finished run is returned as it is) |

`{name}` matches case-insensitively and must be URL-encoded. Errors: 404 `command_not_found`, `review_not_found`, `not_found` (project or run); 400 `invalid_cwd`; 409 `too_many_runs` (4 at once per project), `review_closed`, `worktree_missing`, `no_folder`, `start_failed`.

```text
Run  { id, name, command, cwd (absolute), review_id?, status: "running"|"finished"|"stopped"|"error", exit_code: number|null,
       started_at, finished_at?, duration_ms, output_bytes, truncated, tail? }
```

`exit_code` is null while running and -1 when a signal ended the process. `finished`: the process ended by itself (any exit code); `stopped`: the user's Stop; `error`: it could not run, or the harness stopped while it ran (settled at start by `Recover`, or when read). The last 50 finished runs are kept per project.

## Events

| Event | Payload |
| --- | --- |
| `command.started` | `{ run: Run }` |
| `command.output` | `{ run_id, stream: "stdout"\|"stderr", text }` |
| `command.finished` | `{ run_id, exit_code, duration_ms, status, name, review_id? }` |

Output is sent in chunks of at most 16 KiB cut at character boundaries (invalid bytes become U+FFFD), at most every 50 ms per run, so a chatty command cannot flood the event stream. A run's output is capped at **5 MB** (stdout and stderr together): at the cap the text `\n[output truncated: the 5 MB limit was reached; the rest was dropped]\n` is sent as the last stdout chunk, `truncated` is true, and the rest is read and dropped (the process is not blocked). The kept `tail` is the last 64 KiB in arrival order. Stderr and stdout are separate pipes, so their relative order across the two streams is approximate.

**Stop** sends SIGTERM to the process group (`Setpgid`; children die with it), waits 3 s, then SIGKILL. On Windows there are no process groups: the process itself is killed. A run is also killed when the harness shuts down.

## Suggestions

Read from the top level of each project folder, never run: `package.json` `scripts` (in file order; names with shell-special characters are left out; run as `pnpm run` / `yarn` / `bun run` / `npm run` by the lock file), `Makefile`/`makefile`/`GNUmakefile` explicit targets (no pattern rules, special targets or recipes' lines; `make <t>`), `justfile`/`Justfile`/`.justfile` public recipes that need no argument (`just <r>`). At most 100; `configured` says a command of that name exists. `cwd` is the folder's label. Files over 1 MB are not read.

## In a review

`POST …/commands/{name}/run { review_id }` runs in that review's worktree. The review's `meta.runs` lists them, newest first, at most 20: `[{ id, name, status, exit_code, started_at, finished_at? }]` (read from the run history when the review is read).

## Not verified here

Windows (no bash; process groups), a command that detaches a daemon out of the process group, very long single lines of output, and real dev servers.
