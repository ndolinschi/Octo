# Errors speak the person's language (decision 94b)

Everything the harness says for a person to read (a failed turn, a notice, a provider that is not ready, an error body) has one
structured form, built by one catalogue: `internal/usererr`.

| Field | What it is |
| --- | --- |
| `message` | One plain sentence of what happened ("GitHub Copilot is not logged in."). No protocol words, no exit status. |
| `hint` | The next step in plain words ("Log in to it in a terminal, then check again."). |
| `command` | A copyable terminal command when there is one (`copilot login`). |
| `action` | A machine code the UI turns into a button: `recheck_provider`, `connect_provider`, `retry`, `open_settings`, `update_agent`, `use_worktree` (a refused branch switch: the UI offers "Start in a worktree from <branch>"), `switch_account` (a usage limit: the UI offers another account of the same agent, or another model, and sends the request again). Absent means none. |
| `details` | The technical text (protocol names, exit status, the stderr line, method names), for a "Details" fold and the diagnostic report. |

All five are additive: existing fields stay. Where a route used to return technical text in `message`, the text is now `details` and
`message` is the plain sentence.

## Where they appear

| Surface | Fields |
| --- | --- |
| HTTP error body `{"error": {...}}` (every route) | `code`, `message`, and when set `hint`, `command`, `action`, `details`. `model_unavailable` (now only sent by the retired checks of older builds) also `provider`, `reason`, `can_force`. `rewind_conflict`: `details` stays the report object (machine data). |
| `turn.finished` | `error` (the plain message; for a completed turn with a notice `warning: <message>`), `hint`, `command`, `action`, `details`; a notice also as `notice: {message, hint, command, action, details}` |
| `project.attention` | `error` (plain message) with `hint`, `command`, `action`, `details` |
| `side.error` | `error` (plain message), `code`, `hint`, `command`, `action`, `details` |
| agent rows | `error` = plain message, `error_hint` = hint. Command, action and details are not stored (no schema change): after a restart a failed row has message and hint only |
| `GET /v1/providers` | `reason` = the plain message while not ready; `problem` = `{message, hint, command, action, details}`; `models_error` = plain message, `models_problem` the same structure |
| `GET /v1/plugins` | agents add `login_command` (manifest `auth.command`) |

## The catalogue

Constructors live in `internal/usererr/catalogue_*.go`: `catalogue_agent.go` (an ACP agent as the person knows it),
`catalogue_service.go` (turns, routes, providers), `catalogue_review.go` (code host, git), `catalogue_generic.go` (the plain wording of a
route's own error code, `usererr.Generic(code, technical)`). A failure of a kind nobody wrote a sentence for becomes `usererr.Unexpected`
("Something went wrong inside Octo."), its text kept as `details`: `orchestrator.describe` does that at the end of every turn, side
question and child agent.

Callers use the constructors; `project.Error` carries one (`User`), the review service maps its codes to them (`review.Error.Catalogue`),
the bridge writes them (`writeProblem`, `writeError`, `errorBody`). `writeError(w, status, code, msg)` is for a route's own error whose
`msg` is technical: the body gets `usererr.Generic(code, msg)`, `msg` becomes `details`.

## The rule, and how CI keeps it

1. `TestCatalogueWording` (`internal/usererr/catalogue_test.go`) builds every constructor with sample arguments (and every code of
   `Generic`) and checks `message` and `hint`: none of "ACP", "MCP", "exit status", "stderr", "JSON-RPC", "session/", "initialize",
   "spawn_agent", a Go error chain (`: ` three times), a tool id with an underscore; starts with a capital letter, ends with a period;
   at most 140 characters; the action is one of the known codes. `TestEveryConstructorIsListed` parses `catalogue_*.go` and fails for a
   constructor without a sample, so a new case cannot skip the rules.
2. `TestNoAdHocStrings` (`internal/usererr/sweep_test.go`) parses the non-test files of `bridge`, `project`, `review`, `commands`,
   `settings` and collects the first string literal given to `writeError`, `invalid`, `conflict`, `notFound`, `fileTooLarge` or set as the
   `Message` of an `&Error{}`. The set must equal `testdata/adhoc_strings.txt`. A new literal fails the test: use or add a constructor, or (only
   for technical text that is `details` for the client's developer) add the line with
   `UPDATE_ADHOC=1 go test ./internal/usererr -run NoAdHoc` and justify it in review. A line that matches nothing any more fails as stale.

## Cases

| Constructor | Message |
| --- | --- |
| `AgentNotLoggedIn` | "<Agent> is not logged in." (command: the login command, action `recheck_provider`) |
| `AgentNotInstalled` | "<Agent> is not installed." (`recheck_provider`) |
| `AgentLaunchRejected` | "<Agent> did not start the way Octo asked." (`update_agent`) |
| `AgentTooOld` | "<Agent> <version> is too old for Octo; it needs <min> or newer." Hint "Update it, then check again."; command: the install line (running the installer again updates); code `agent_too_old` (`recheck_provider`). From the manifest's `version` check, before anything starts the agent (2026-11-15, Antigravity). |
| `AgentExitedDuringStart` | "<Agent> stopped while starting." (`retry`) |
| `AgentTimedOut` | "<Agent> did not answer in time." (`retry`) |
| `AgentRefusedToolServer` | "<Agent> could not use Octo's tools this time; the request ran without delegation and notes." (`update_agent`) |
| `AgentModelRejected` | "<Agent> does not offer the model <model>." (`open_settings`) |
| `AgentSilent`, `AgentNoAnswer`, `AgentStopped`, `AgentCrashed`, `AgentFailed`, `AgentUnavailable` | see `catalogue_agent.go` |
| `NoProvider`, `ProviderNotConnected`, `ProviderNotSupported`, `ProviderNotWorking` | provider states (`connect_provider` / `recheck_provider`) |
| `ProviderNotRunning` | "<Provider> is not running." (a local URL; hint "Start it, then check again.", command `ollama serve` for Ollama) or "<Provider> does not answer." (a remote URL; hint: check the server and its URL). Code `provider_not_running` (`recheck_provider`); details: "Nothing answered at <url>: <cause>." State `not_running` of Ollama and of the API on a local base URL (providers.md, 2026-11-18). |
| `BudgetReached` | "This project's budget is used up ($X of $Y)." (`open_settings`) |
| `BudgetCut` | "This project's budget ran out during this request ($X of $Y); the answer was stopped mid-request." Hint: what it had written is kept. Code `budget_reached` (`open_settings`) |
| `TurnInProgress`, `SideInProgress`, `QueueFull`, `ImagesUnsupported`, `SteerUnsupported`, `NothingToCompact`, `CompactUnsupported`, `BuiltinLoopOff`, `NewerSchema`, `PlanNotPending`, `FileChanged`, … | `catalogue_service.go` |
| `GitHubCLIMissing`, `GitHubCLINotLoggedIn`, `GitHubNoRemote`, `GitMissing`, `RepoMismatch`, `DirtyWorkingCopy`, `CheckoutConflict`, `FetchFailed`, … | `catalogue_review.go` |

## Not covered

Messages that only a model reads (tool results such as "spawn_agent requires role, title and task"), diagnostics (`harness doctor`,
`GET /v1/diagnostics`), the `unavailable_reason` of `GET /v1/plugins` (technical; the screen reads `GET /v1/providers`), memory tool errors
and the sentences inside `Generic`-wrapped routes (their text is `details`). Manifest labels are shown as written (the Pi entry's label
contains "ACP"). No real agent CLI was run: every case was produced by the scripted agent (`internal/fakeacp`) or a unit test.

## Added 2026-11-14

- `turn_interrupted` (`TurnInterrupted`, action retry): a turn that was running when the service stopped; set on start
  by recovery.
- `model_unreachable` (`ModelUnreachable`) and `router_unreachable` (`RouterUnreachable`): the upstream connection broke
  (unexpected EOF, refused, reset); the router wording is used when a router is configured.
- `request_too_large` (`RequestTooLarge`, HTTP 413): any JSON body over 1 MiB.
- `data_dir_in_use` (`DataDirInUse`): a second service on a data folder that is in use; it stops before opening the store.
- `agent_not_installed` is now also returned when an agent's program is missing at load, with the plugin's install line
  (it used to read "cannot be used" and the UI added a login command).


## Added 2026-11-14 (parallel sessions, phase 1)

`catalogue_sessions.go`, with samples in `TestCatalogueWording`:

| Code | Constructor | Message | Used |
| --- | --- | --- | --- |
| `worktree_unavailable` (409) | `WorktreeUnavailable` | "None of this project's folders is in a git repository, so a separate worktree cannot be made." | `POST /sessions` with `workspace.kind: "worktree"` (phase 1 has the shared workspace only; `details` says so) |
| `worktree_failed` (502) | `SessionWorktreeFailed` | "The session's worktree could not be made." (`retry`, git's text as `details`) | phase 3 |
| `workspace_not_found` (404) | `WorkspaceNotFound` | "That workspace no longer exists." | `POST /sessions` with a `workspace.id` other than `shared` |
| `workspace_missing` (410), `workspace_dirty` (409), `workspace_in_use` (409), `apply_conflict` (409) | `WorkspaceMissing`, `WorkspaceDirty`, `WorkspaceInUse`, `ApplyConflict` | see the file | phase 3 |
| `coordination_off` | `CoordinationOff` | "Sessions of this project do not coordinate." (`open_settings`) | phase 4 |
| `session_slots_full` (409) | `SessionSlotsFull` | "As many sessions as allowed are running already." (`open_settings`) | a turn that cannot wait in a queue (approving a plan, `/compact` sent to an agent) while the running caps are reached; a plain message waits in its session's queue instead (`waiting_for: "slot"`) |

`current_session`, `session_running`, `not_main_session`, `queue_full` and `turn_in_progress` keep their wording; `queue_full`
is now per session (20 waiting messages of one session).

## Added 2026-11-19 (branch choice in the composer, UI decision 100)

`catalogue_branches.go`, with samples in `TestCatalogueWording`. Used by `GET /branches` and `POST /branches/switch`
(`sessions.md`, "Branches of the main checkout"); every refusal leaves the checkout as it was.

| Code | Constructor | Message | Used |
| --- | --- | --- | --- |
| `uncommitted_changes` (409) | `UncommittedChanges` | "The main checkout has uncommitted changes, so it stays on its branch." (`use_worktree`, the files as `details`) | a switch while tracked files have staged or unstaged changes |
| `checkout_in_use` (409) | `CheckoutInUse` | "A session is working in the main checkout, so it stays on its branch." (`use_worktree`) | a switch while a main session of the shared workspace works or waits |
| `branch_switch_failed` (409) | `BranchSwitchFailed` | "Git did not switch the branch, so nothing was changed." (`use_worktree`, git's text as `details`) | git refused (an untracked file it would overwrite, a branch checked out in another worktree) |
| `branch_not_found` (404) | `BranchNotFound` | "There is no branch of that name in this repository." | a switch to a name that is no local branch |
| `branch_exists` (409) | `BranchExists` | "A branch of that name exists already." | create-and-switch with a taken name |
| `invalid_branch_name` (400) | `InvalidBranchName` | "That is not a valid branch name." | create-and-switch with a name `git check-ref-format --branch` refuses; an empty `branch` |
| `not_a_git_repository` (409) | `NotAGitRepository` | "This folder is not in a git repository." | `folder` names a folder outside git, or no folder of the project is in git |
| `invalid_request` (400) | `InvalidPage` | "That part of the list cannot be shown." | `offset` or `limit` is not a whole number of zero or more |

## Added 2026-11-14 (owner's fourth re-test)

- `turn_interrupted` has two hints (NEW-9): "What it had written before the restart is kept. Retry to run the request
  again." only when the interrupted turn had stored assistant text; otherwise "Nothing had been written yet. Retry to run
  the request again." (`TurnInterrupted(kept)`). The exchange carries the same fact as `kept_text` (`memory.md`).
- `BudgetCut` (code `budget_reached`): a built-in request under a budget asks for at most the output the rest of the
  budget buys (P2-11); an answer that reached that cap ends the turn with this message, its text kept and flagged
  `stopped`.
- `agent_exited_on_start` ("<Agent> stopped while starting.") is now only for an agent process that ended before it was
  ready: during the start-up handshake or before `session/new` answered (that case used to read `agent_crashed`). An
  agent that dies after its turn began is `agent_crashed` ("<Agent> stopped in the middle of the request.", hint "Try
  again. Octo starts it again by itself.", action `retry`). NEW-10: an ACP orchestrator whose prompt failed because the
  process was gone is started again and sent the request once more only when the prompt failed within a second of being
  sent (the process had died between turns); an agent that worked on it silently and then died is no longer restarted
  with the request sent a second time, and so no longer ends as "stopped while starting" when that restart fails.

## Added 2026-11-14 (remote access)

`catalogue_remote.go`; details in [remote-access.md](./remote-access.md).

| Code (status) | Constructor | Message | When |
| --- | --- | --- | --- |
| `cloudflared_missing` (in `GET /v1/remote` `error`) | `CloudflaredMissing(install)` | "Remote access needs Cloudflare's tunnel program, and it is not installed." (command: the install line, action `retry`) | turning remote access on without `cloudflared` |
| `tunnel_failed` (in `error`) | `TunnelFailed(tail)` | "The tunnel to Cloudflare could not be opened." (details: the last output lines) | 5 failed runs in a row, or the listener could not open |
| `remote_ack_required` (409), `remote_off` (409) | `Remote(code)` | "Remote access has to be confirmed the first time." / "Remote access is off." | first `enable` without `acknowledge`; a pairing code while off |
| `remote_forbidden` (403), `remote_read_only` (403) | `Remote(code)` | "A paired phone cannot do this." / "This phone can only read." | a device on a denied route / a read-only device on a send, answer or stop route |
| `remote_decision_forbidden` (403) | `Remote(code)` | "A paired phone can only allow or deny one request at a time." | a device answers an approval with anything but a single `allow` or `deny` |
| `device_not_paired` (401), `device_pending` (403), `device_expired` (401) | `Remote(code)` | "This phone is not paired, or it was disconnected on the computer." / "…waiting to be allowed on the computer." / "…not used for too long and was disconnected." | unknown or revoked token (the local API token too) / not yet allowed / idle too long |
| `pairing_code_invalid` (403), `pairing_code_expired` (403), `pairing_locked` (423), `pairing_backoff` (429), `pairing_rate_limited` (429) | `Remote(code)` | "That pairing code is not right." / "…has expired." / "Too many wrong codes were tried." / "Too many wrong codes were typed here." / "Too many tries at once." | `POST /pair/claim` |
| `stream_gone` (410), `query_token_refused` (401) | `Remote(code)` | "The live updates stopped." / "A token in the address is not accepted here." | long poll / `?token=` on the tunnel listener |

`TestRemoteWording` holds every code to the sentence rules.

## Added 2026-11-15 (schema forms, phase A1)

`catalogue_forms.go`, with samples in `TestCatalogueWording`:

| Code (status) | Constructor | Message | When |
| --- | --- | --- | --- |
| `invalid_request` (400) | `FormAnswerRefused(n, technical)` | "One answer in the form needs attention." / "Some answers in the form need attention." (hint "Fix the marked fields, then submit again.", `details` "id: message; …") | `POST /v1/projects/{pid}/inputs/{id}` with an answer the form refuses; the body also carries `error.fields {id: message}` ([v7.md](./v7.md) §4). Never a value. |

## Added 2026-11-17 (OpenCode compaction, mid-turn errors, and `/compact` retry)

- `agent_no_answer` (`AgentNoAnswer(label, details)`): `"<Label> stopped before writing an answer."` (hint `"Try sending your request again."`, `action: "retry"`). Returned when an external agent streamed reasoning without producing answer text or tool calls, instead of misreporting it as `agent_silent`.
- Mid-turn `agent_error` updates (`ProviderAuthError`/HTTP 401 -> `AgentNotLoggedIn`; other errors -> `AgentFailed`) and silent-turn `stderr` capture (`AgentSilent` now keeps redacted trailing `stderr` in `details` alongside the login hint).
- Retrying a failed `/compact` turn routes through `POST /compact` (`bridge.compactNow`) instead of `POST /messages` (avoiding `octo_command`), and `ErrorNotice` hides the `"Checked just now"` line when `[Check again]` triggers a retry that fails.

## Added 2026-11-17 (interactive terminals)

`catalogue_generic.go`, tested in `TestCatalogueWording`:

| Code (status) | Constructor | Message | When |
| --- | --- | --- | --- |
| `too_many_terminals` (429) | `Generic("too_many_terminals", …)` | "There are too many terminals open for this project." (hint "Close one, then try again.") | `POST /v1/projects/{pid}/terminals` when the per-project PTY session cap (8) is reached |
| `terminal_closed` (410) | `Generic("terminal_closed", …)` | "That terminal session has ended." (hint "Start a new terminal, or restart it.", action `retry`) | `POST …/input` or `POST …/resize` after the shell process or session has closed |
| `terminal_already_subscribed` (409) | `Generic("terminal_already_subscribed", …)` | "That terminal is already open elsewhere." (hint "Close the other tab, then try again.") | Second concurrent `GET …/terminals/{sid}/events` SSE subscriber on the same session |


## Added 2026-11-19 (operational robustness)

`catalogue_ops.go`, with samples in `TestCatalogueWording`:

| Code (status) | Constructor | Message | When |
| --- | --- | --- | --- |
| `project_unavailable` (409; also the `error` of a `status: "unavailable"` entry of `GET /v1/projects`) | `ProjectDamaged(backup, details)` | "This project's saved data is damaged, so Octo cannot open it." Hint: Octo left the file untouched; restore it (when a `.pre-*` copy exists: "A copy made before an update is beside it (see details)"), or remove the project. | `project.sqlite` is not a database, truncated or malformed. `details`: the file, the SQLite text, the backups. |
| `project_unavailable` | `ProjectUnreadable(details)` | "Octo cannot read this project's saved data." | permission or I/O errors opening the file |
| `newer_schema` | `NewerSchema` (existing) | "This project was saved by a newer version of Octo." Hint "Update Octo to open it." | `user_version` above this build's; now also listed instead of stopping the start |
| `registry_unavailable` (stops `harness serve`) | `RegistryUnavailable(path, details)` | "Octo cannot open its list of projects." Hint: left untouched; restore it, or move it away to start with an empty list. | `registry.sqlite` damaged |
| `folder_missing` (409; also the `error` of a project in `GET /v1/projects` and `GET /v1/projects/{pid}`) | `FolderMissing(label, path, details)` | "The project folder <label> is missing." Hint "Put the folder back where it was, or remove it from the project in its settings." (`open_settings`; `details`: the path and the stat error) | a project folder that is gone, not a folder or unreadable: sending a message, starting a terminal, a Processes run (`POST …/runs`, `…/commands/{name}/run`), the file routes of that folder. These used to say `internal` "fork/exec /bin/bash: no such file or directory". |

## Added 2026-11-26 (agent accounts and usage limits)

`catalogue_accounts.go`, with samples in `TestCatalogueWording`. The refusals of adding, renaming and removing an account are the cases of the first accounts release in the same file (`AccountsNotSupported`, which now carries the manifest's reason in `details`, `AccountNameInvalid`, `AccountFolderInvalid`, `AccountTaken` (also a rename to a name another login of the agent has), `AccountsFull`, `AccountGone`); the rows below are the additions. The new action `switch_account` is in `usererr.Actions` and in `ErrorAction` of `@octo/agent-client`.

| Code (status) | Constructor | Message | When |
| --- | --- | --- | --- |
| `agent_limit_reached` (a failed turn or sub-agent; action `switch_account`) | `AgentLimitReached(label, details, accounts)` | "<Agent> · <Account> has reached its usage limit." Hint "Pick another account or model and retry, or wait until the limit resets."; when the agent keeps one login only (`accounts` false) "Pick another model and retry, or wait until the limit resets." | An agent's error was classified as a plan's usage limit (structured `rate_limit`, a quota code or a manifest pattern; [`acp-orchestrator.md`](acp-orchestrator.md#usage-limits-and-switching-accounts-2026-11-26)). `details`: the agent's own text. The agent is shown as at its limit |
| `agent_limit_reached` (same code and action) | `AgentRateLimited(label, details, accounts)` | "<Agent> · <Account> is being rate limited." Hint "Retry in a moment, or pick another account or model."; one login only: "Retry in a moment, or pick another model." | A bare rate limit: HTTP 429 or `RATE_LIMIT_EXCEEDED` with no plan-limit sign. Transient: the agent is **not** shown as at its limit |
| `conflict` (409) | `AccountFolderNotOwned()` | "Octo did not create this account's folder, so it will not delete it." Hint "Remove the account and keep its folder, then delete the folder yourself if you no longer need it." | `DELETE /v1/providers/{id}/accounts/{account}?delete_folder=true` for a folder Octo did not create (or that is no longer a plain folder at the account's path, or a place it never deletes). Nothing is removed |
| `login_unavailable` (409; action `recheck_provider`) | `LoginUnavailable(label, command, details)` | "<Agent> cannot be logged in from Octo." Hint "Log in to it in a terminal, then check again."; command: the text to run by hand | The agent has no `auth.login` command, the named method does not exist, or the command did not start. An agent whose CLI is not installed (or too old) gets `agent_not_installed` (`agent_too_old`) from the login route instead, with its install line, and no terminal is started |
