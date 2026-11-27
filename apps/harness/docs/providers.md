# Providers

A *provider* is anything that can run a model: the built-in Messages-API loop (an API key or a gateway), a detected Octo router, or an ACP agent CLI on this machine. `GET /v1/providers` says which are ready, what each offers and how to make the others ready, so a client can connect first and choose second (UI decisions 53 and 58). Nothing in this feature runs a provider or an agent: states come from configuration, the plugin registry (command found, background login probe) and a cache of the models agents advertised.

## `GET /v1/providers`

```json
{
  "connected": 2,
  "suggested": { "orchestrator": "claude-sonnet-5-5", "fast": "claude-haiku-5-5", "balanced": "claude-sonnet-5-5", "deep": "claude-opus-5-5" },
  "providers": [
    { "id": "api", "kind": "api", "label": "Anthropic API", "state": "ready", "reason": "",
      "install_hint": "", "login_hint": "Add an API key in Settings (ANTHROPIC_API_KEY).",
      "models": [{ "id": "claude-opus-5-5", "label": "Claude Opus 5.5", "source": "catalogue" }],
      "default_model": "claude-sonnet-5-5", "flat_rate": false },
    { "id": "claude-code", "kind": "agent", "label": "Claude Code", "state": "ready", "reason": "",
      "install_hint": "", "login_hint": "Run `claude` once.",
      "models": [
        { "id": "opus", "label": "Opus", "source": "manifest" },
        { "id": "default", "label": "Default (recommended)", "source": "advertised", "seen_at": "2026-11-12T12:00:00Z" },
        { "id": "my-model", "label": "my-model", "source": "custom" }
      ],
      "default_model": "default", "flat_rate": true,
      "models_refreshed_at": "2026-11-12T12:00:03Z", "models_note": "Aliases accepted by the Claude Code CLI's --model flag ...",
      "accepts_custom_model": true, "login": "unchecked",
      "preferred_model": "opus", "roles": { "fast": "haiku", "balanced": "sonnet", "deep": "opus" } }
  ]
}
```

Agent entries carry more than the others: `models_refreshed_at` (RFC 3339, when the harness last looked for the models, found or not), `models_error` (short text, only when that look failed; not an error of the provider), `models_note` (the manifest's remark on its list), `accepts_custom_model` (always `true`: any model name can be chosen), `login` (below), `preferred_model` (`""` when none) and `roles` (always the three keys; `""` = the agent's own default). `models[].source` is `catalogue`, `manifest`, `advertised`, `command` or `custom`.

Order: `api`, then `router` (only while an Octo router is detected), then one entry per ACP agent in manifest order with `claude-code`, `copilot`, `grok` first; the accounts of an agent follow it directly.

| Entry | `ready` when | Models |
| --- | --- | --- |
| `api` | the built-in loop can run (a key, an Octo key, or a base URL other than the Anthropic API) and no router is detected. With a router detected it is `not_connected` ("runs through the Octo router") | `catalogue`: the three compiled-in tiers plus any non-ACP default model |
| `router` | an Octo router answered its health check | the same catalogue |
| agent | the command (and every `requires` entry) is found and nothing positively says "logged out" (see **Login** below). An agent with no probe, a probe still running, or a probe that could not tell is ready | manifest `models`, then the models command's, the advertised ones and the typed ones |

States: `ready`, `not_running` (Ollama, and the API on a local base URL: nothing answers at its URL; see **Reachability** below), `not_connected` (API, router), `not_supported` (an agent whose manifest says `unsupported`: `reason` is the manifest's text, the install hint is kept; never ready, never probed or started, never a router candidate, `acp:<id>` is refused with 422 `model_unavailable` and that reason, not forceable), `not_logged_in` (`login_hint` = manifest `auth.hint`), `not_installed` (`install_hint` = manifest `install`, `reason` = what is missing), `error` (reserved, never produced yet). `connected` counts `ready` entries. `flat_rate` is the manifest's `flatRate`.

### Login (connected means selectable)

`login` is `"ok"` (the probe succeeded), `"not_logged_in"` (the probe positively said so; state `not_logged_in`) or `"unchecked"` (state `ready`): there is no probe (Copilot, OpenCode ...), or it is still running, failed to start, timed out, exited with a status the manifest does not document, or printed something unexpected. An unchecked agent can be chosen and a project can be created on it; if it is really logged out the first turn fails with the agent's own "not logged in" message and the login hint. The agent counts as logged out only when the probe exits non-zero and either its output (stdout and stderr) matches the manifest's `auth.notLoggedInPattern` or its status is listed in `auth.notLoggedInExit`. **Exit 0 always wins**, whatever the probe prints. Why a probe was inconclusive is kept for `harness doctor` / `GET /v1/diagnostics` (`probe.reason`: "the probe exited with status 3, which the manifest does not list as logged out: login not checked"), never shown as an error and never quoting the probe's output. The built-in manifest lists exit status 1 for claude-code, codex, cursor and devin (the conventional "not logged in" status; unverified here) and no status for Grok, whose probe `grok models` exits 0 and prints "You are not authenticated." when logged out: since exit 0 wins, a logged-out Grok reads as `unchecked` and its first turn fails with Grok's own message and the login hint.

### The login probe is advisory (decision 2026-11-12)

A probe is a guess made earlier by another process; the agent's own session is the truth.

1. **Fresh before refusing.** Before a request is refused for `not_logged_in` (a model switch inside a running project, a sent request), the agent's probe is re-run synchronously, at most once per 5 s per agent (`plugins.Registry.Fresh`). A probe that now passes lets the request through.
2. **Negative results expire fast.** A "not logged in" result is probed again after 15 s whenever providers are being read (any request that lists them), a positive one after the usual minute.
3. **`POST /v1/providers/{id}/recheck`** (no body) runs the probe now, joining one already running, and answers `200` with the provider entry exactly as `GET /v1/providers` lists it (`state`, `login`, ...); `providers.updated` follows when the picture changed. `404 not_found` for an id that is neither an agent nor a probed provider (`ollama`, and `api` on a local base URL, which it probes for reachability; see below). An unsupported or uninstalled agent is answered without running anything.
4. **Creating a project never needs a login.** `POST /v1/projects` and `PATCH /v1/projects/{id}` store the models as sent, whatever the state of their providers (not logged in, not installed, too old, not supported, API or router not connected, nothing connected at all); there is no `model_unavailable` or `no_provider` answer there any more (decision 2026-11-15: a project is a folder and settings). `force_unverified` is still read and ignored, so an older client's body works. The project lists the models that cannot run in `models_unavailable`; the client says so calmly (login steps, "Check again", "Choose another model") and the request that is sent later fails with the agent's own error and the login hint. Unknown agents and malformed models stay `400 invalid_request`.
5. **Why, without leaking.** `harness doctor` and `GET /v1/diagnostics` give each agent's `probe`: `rule` (`pattern`, `exit_status`, `exit_0`, `other_exit`, `timeout`, `not_started`, `none`), `exit_status` (null when it did not exit), `duration_ms`, `dir` (the working directory) and `env_names` (names only, never values). `harness doctor --show-probe-output` also prints the first 20 lines of each probe's output (text only: it is never in JSON, never in `/v1/diagnostics`, never sent to a model). A built-in agent's probe runs in the user's home directory like a terminal; a plugin directory's agent in that directory.
6. **Same environment as a terminal.** The probe and the agent get HOME, USER, LOGNAME, XDG_*, PATH, SHELL, LANG, LC_*, TMPDIR, SSH_AUTH_SOCK and on macOS `__CF_USER_TEXT_ENCODING` when the harness process has them (`childenv`'s allow-list; a test asserts each). Everything else stays dropped (no `*KEY*`, `*TOKEN*`, `ANTHROPIC_*`, `XAI_*`, ...). `__CF_USER_TEXT_ENCODING` was missing before.

### Reachability of Ollama and a local base URL (2026-11-18)

Ollama's list is a catalogue (the four tags it is likely to have), so on its own it says nothing about whether anything can run; QA found Ollama reading "Ready · 4 models" with nothing on `:11434`. The harness now probes, like the advisory login probe of agents:

1. **What is probed.** `ollama`: its URL (`HARNESS_OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`), local or remote. `api`: the built-in loop's base URL (`ANTHROPIC_BASE_URL` / `--base-url`) only when it is on this computer (`localhost`, a loopback address: a gateway, LM Studio, the mock model) and the loop is otherwise ready; the Anthropic API and a remote gateway are never probed.
2. **How.** An HTTP `GET` of the URL with a 1.5 s timeout; any answer, whatever its status, is reachable. Only a failure to connect or no answer is not.
3. **Cached, re-checkable.** The first read probes at once; then a negative result is probed again after 15 s and a positive one after a minute, in the background whenever providers are read (the 15 s provider watch included), and `providers.updated` follows a change. `POST /v1/providers/{id}/recheck` with `ollama` (or `api` on a local base URL) probes now and answers the entry, the same as for an agent's login.
4. **What it says.** `reach`: `ok`, `not_running` or `unchecked` (no probe configured: library embedders). With nothing answering the state is `not_running` and `problem` is `ProviderNotRunning` (errors.md): "Ollama is not running.", hint "Start it, then check again.", command `ollama serve`, action `recheck_provider`, details "Nothing answered at <url>: <cause>."; a remote Ollama "does not answer" (no command); the API on a local URL is "The model server is not running." `models` stay listed (the catalogue), but `small` and `ollama:<tag>` are reported unavailable (`Check`, a project's `models_unavailable`) while Ollama is not running. Ollama is never counted in `connected`.

Verified: `internal/providers/reach_test.go` (fake probe: states, problem, caching, recheck, local vs remote base URL, no probe), `cmd/harness` `TestServeOllamaStateFollowsItsServer` (real HTTP probe against a closed port, then a listener and `/recheck`), and the UI in the browser against a live harness. Not verified: a real Ollama install.

### Experimental agents

A manifest agent has `verified` (default false) and `verifiedNote`. `GET /v1/providers` gives `experimental: true` (and `experimental_note`) for an agent that is not verified: its launch command comes from documentation and has not been run with Octo. Only `claude-code`, `grok` and `copilot` are verified in the built-in manifest. `harness doctor` prints it. A start-up failure caused by rejected launch arguments is explained in the turn error (see `acp-orchestrator.md`).

### An agent CLI that is too old (2026-11-15)

A manifest agent may carry `version` (`{"command": [...], "min": "1.5.0"}`; built-in: Antigravity, `agy --version`, 1.5.0).
The version is read in the background and on `POST /v1/providers/{id}/recheck`; when a version was read and is lower than
`min`, the agent is `not_installed` with `problem` "<Agent> <version> is too old for Octo; it needs <min> or newer.", the
install line as `command` (running the installer again updates) and `recheck_provider`; choosing it is refused with 422
`model_unavailable` (not forceable). Output without a version, a failure or a timeout change nothing.

### Antigravity

Not run with Octo (experimental). It has no login probe (agy documents no non-interactive status command): its login is
`unchecked` until a session says otherwise. Model discovery opens a throw-away `agy acp` session, so a signed-out agy shows
`models_problem` "Antigravity is not logged in." with `agy acp --login` before any request; the first request fails with the
same notice. Models come only from agy's own model picker (its session config option): no names in the manifest, no `roles`,
so the fast, balanced and deep tiers on Antigravity use agy's own default until the user sets roles (`PUT /v1/providers/antigravity/prefs`).
Details: `acp-orchestrator.md`, "Antigravity (`agy`)".

### Agent models

`models` is, in this order and each id once (the first source wins): the manifest's `models` (`source: "manifest"`, with the manifest's `modelLabels`), what the manifest's `modelsCommand` printed (`"command"`), every model the agent advertised in a session the harness opened or discovered (`"advertised"`) and the names typed by the user (`"custom"`). `seen_at` is when a session last advertised a model. `stale: true` flags an **advertised** model the agent's latest session did not advertise; it is kept, never dropped (a manifest alias is the CLI's own name and is never flagged). `default_model` is the manifest's `defaultModel`, else the model the agent reported as current.

**Any model can be chosen.** Choosing `acp:<agent>/<anything>` is accepted for a ready agent whether or not the model is listed (the name must be 1 to 100 characters, start with a letter or digit and hold no whitespace or control characters). It reaches the agent as the manifest's start-up argument (`modelArg` / `{modelArgs}`) when there is one, else as the session's model config option, else as `session/set_model`; a model the agent did not list is sent all the same. If the agent refuses it, the turn (or the sub-agent) fails with "<agent> does not accept model <name>" and a hint: "It advertises: a, b, c." (what its session offered; else what the manifest lists; else "It advertised no models in this session."). An agent that exits at start-up with a `modelArg` that names a refused model fails the same way ("... (it did not start with it)"). `spawn_agent`'s `model` is free text for the same reason (its schema describes the known models and has no enum).

**Model discovery without a user request.** When an agent becomes ready (its command resolves and its probe answered: logged in, or could not tell, or there is no probe), when its login changes, and on `POST /v1/providers/{id}/refresh-models`, the harness:

1. runs the manifest's `modelsCommand` when there is one (`{command: [...], pattern, labelGroup?}`; the pattern is matched against every output line, group 1 is the model id, `labelGroup` a display name; child environment allow-list plus the entry's `env`, 10 s, 64 KiB of output, at most 100 models, ids validated). When it finds at least one model the session is not needed;
2. otherwise starts the agent in a fresh empty temporary directory, does `initialize` and `session/new` with no MCP servers, reads the models its answer lists, and closes the process and removes the directory. **No prompt is ever sent**, so nothing is billed. Every place the ACP schema lists models is read: a model config option (flat or grouped: `{value, name}` entries or groups holding them), the `models` object (`{currentModelId, availableModels: [{modelId, name}]}`), `models` as a bare array of `{id, name}` / ids, and `models` under the result's `_meta`.

Limits: 20 s per discovery (a longer one is `models_error: "timed out after 20s"`), one at a time per agent (a forced refresh joins the running one), at most once an hour per agent unless forced or its login changed (failures count), and never while that agent has a live session of a project (its process is in use; the models of its live session, already recorded when that session opened, are read instead). A failure is recorded as `models_error` (a short line such as "the agent is not logged in" or "the agent advertised no models") together with `models_refreshed_at`, never thrown, and a later success clears it. `providers.updated` is published when the picture changes. `HARNESS_MODEL_DISCOVERY=0` turns discovery off (the endpoint then answers `409 discovery_off`).

**`POST /v1/providers/{id}/refresh-models`** (no body) waits for the discovery and answers `200` with the provider entry as `GET /v1/providers` lists it (a failed look is `models_error` on it, not an HTTP error). `404 not_found` for an unknown agent id (the `api` and `router` entries have no models to refresh); `409 not_ready` when the agent is not installed or positively logged out (`message` says which); `409 discovery_off`.

**`PUT /v1/providers/{id}/custom-models`** `{"models": ["name", ...]}` replaces the names typed for the agent and answers `200` with the provider entry. A name is 1 to 80 characters, starts with a letter or digit, no whitespace or control characters; at most 50 per agent, duplicates dropped, `[]` removes them all; one bad name rejects the whole call (`400 invalid_request`, nothing changes); `404` for an unknown agent. A name the manifest already lists stays `manifest`.

**`PUT /v1/providers/{id}/prefs`** `{"preferred_model"?: string, "roles"?: {"fast"?: string, "balanced"?: string, "deep"?: string}}` stores the user's choices globally (same per-agent cache file) and answers `200` with the provider entry. Absent fields are left alone, roles merge key by key, `""` means "the agent's own default" and overrides a manifest hint (`preferred_model: ""` clears the preference). Names are validated like custom models (`400 invalid_request`, `404` for an unknown agent). The manifest may ship role defaults (`roles`; the built-in claude-code entry maps fast to `haiku`, balanced to `sonnet`, deep to `opus`, matching its aliases); the stored value wins.

**Where preferences apply.** (a) A project model `acp:<agent>` without a model runs on the agent's `preferred_model`, else its own default (the manifest's `defaultModel`, else whatever the agent chooses). (b) A delegation decided as fast, balanced or deep runs on `roles[tier]` when its tier is mapped to `acp:<agent>` (`models.<tier>`), and when the router chose the agent for a difficulty band (easy: fast, medium: balanced, hard: deep); an explicit `acp:<agent>/<model>` on the project or in `spawn_agent` always wins, and a model hint the router sends is used only when the manifest allows it. (c) The model actually used is what the sub-agent row and the usage rows record (`acp:<agent>/<model>`); the router's candidate for the agent keeps the id `acp:<agent>` and its label names the preferred model ("Claude Code (opus)"). Every change publishes `providers.updated`.

The cache is `{data-dir}/agent-models.json` (mode `0600`, additive fields, ids validated on read, a corrupt file is ignored): per agent the advertised lists and labels, the models command's list, the custom names, the preferences, and the time and error of the last discovery. It is written when something changes, and at most every 10 minutes otherwise.

**Wiring.** The ACP session code reports what an agent advertised through `acp.RunOptions.OnModels`, which `Orchestrator` keeps (`AdvertisedModels(agentID)`) and announces (`OnAdvertisedModels(fn)`, only when the list changed). `harness serve` registers a callback that copies each report into the providers service (`Service.RecordModels`), which merges it with earlier ones and persists it. Discovery is `providers.Discovery` (`Service` option; `serve` adds `Orchestrator.AgentInUse` and the live list); `acp.Client.Discover` is the session part.

### `suggested`

What a project created without models gets: the current defaults (`HARNESS_MODEL_*`) when the API or router is ready (a default naming an agent that is not ready falls back to the compiled-in model of its slot); otherwise the first ready agent in the order `claude-code`, `codex`, `copilot`, then the rest, as `acp:<id>` in all four slots; empty strings when nothing is ready.

## Accounts: more than one login per agent (2026-11-26)

One agent CLI can be logged in to one account at a time. Octo keeps a second login apart by running the CLI with its own login folder, set through the environment variable the CLI documents for that. Each account is a **derived agent** of its base agent, so everything keyed by the agent id (the login probe, the model cache, usage rows, the stored ACP session) is per account without a change.

**Ids.** The default account is the agent's own login and keeps the bare id: `acp:claude-code/opus`. Another account is `<base>@<slug>`: `acp:claude-code@work/opus`. The slug is fixed when the account is added (made from the name: lower case, runs of other characters become `-`, at most 32 characters, `-2`, `-3` added on a clash; `default` is reserved; pattern `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`); the display name is separate and can be renamed. Manifest ids cannot contain `@`, so the two never clash. Nothing is migrated: every stored `acp:<id>` is still the default account. Go: `plugins.SplitID`, `DerivedID`, `ValidSlug`; TypeScript: `splitAgentId`, `agentIdOf` (`@octo/agent-client`).

**Store.** `{data-dir}/agent-accounts.json` (folder `0700`, file `0600`, written atomically): `{"version": 1, "accounts": [{agent, id, name, dir, owned, created_at}], "default_names": {"<agent>": "<name>"}}`. It holds names, slugs and folders only. A file with another `version`, or one that does not parse, is left untouched (never rewritten) and accounts stay off (a log warning); add, rename and remove then answer `409 accounts_file_unusable` (it names the file and says to fix or move it aside and restart), not "one account only". A file that cannot be read at all turns the account routes off (not served). A record whose agent is gone or no longer supports accounts stays in the file and is not offered. A name is 1 to 40 characters, no control characters, and unique per agent ignoring case, **the default account's name included** (it reads `Default` until renamed). Every change is applied at once, without a restart, and publishes `providers.updated`.

**Folder.** By default Octo creates `{data-dir}/accounts/<agent>/<slug>` (`0700`, `owned: true`). With `dir` the account uses a folder that exists already (absolute, or `~/...`, no `${`; two accounts cannot share one, which is judged on cleaned paths with symlinks resolved, so a trailing slash or a symlink does not get round it. The agent's own default home is not compared: the manifest does not say where it is); it is `owned: false` and Octo never deletes it. The CLI writes its own login into that folder, so it sits inside the data folder (a backup of the data folder copies those logins; deleting it logs those accounts out). Octo never reads what the CLI writes there; it only checks the login by running the CLI's own status command (the manifest `auth.probe`) with the account's environment.

**Environment.** An account's child processes (the agent, its probe, its models command, its login) get the base agent's `env` with the manifest's `accounts.env` laid over it, `{dir}` replaced by the folder. These variables exist only in that account's own entry: the default account and the other accounts never see them. For Codex the account's `CODEX_HOME` replaces the base entry's `CODEX_HOME=${OCTO_CODEX_HOME}`, so `OCTO_CODEX_HOME` steers the default account only. The variables are listed per agent in [`../plugins-examples/subscription-agents/plugin.json`](../plugins-examples/subscription-agents/plugin.json) and in the table of the harness [README](../README.md#running-on-subscriptions); the manifest fields are in [`architecture.md`](architecture.md#plugins-and-acp-agents).

### Routes

All under `/v1/providers/**`: local only, a paired device cannot call them (`internal/remoteaccess/rules.go`). They exist only while the harness has an accounts store. Errors are catalogue errors ([`errors.md`](errors.md#added-2026-11-26-agent-accounts-and-usage-limits)).

| Route | Body | Answer | Errors |
| --- | --- | --- | --- |
| `POST /v1/providers/{base}/accounts` | `{"name", "dir"?}` | `201 {"account", "provider"}` | `404 not_found` (unknown agent); `409 accounts_unsupported` (the manifest's reason in `details`); `409 account_name_taken`; `409 accounts_file_unusable` (the accounts file cannot be read; it is not changed); `400 invalid_request` (empty or over-long name, `dir` not absolute or not an existing folder, `dir` already used) |
| `PATCH /v1/providers/{id}/account` | `{"name"}` (a base id renames the default account) | `200 {"account", "provider"}` | `404`; `409 account_name_taken`; `409 accounts_unsupported`; `409 accounts_file_unusable`; `400` |
| `DELETE /v1/providers/{id}/account?delete_data=bool` | none | `200 {"removed": id, "deleted_dir": path or null}` | `404`; `409 account_default` (the default account cannot be removed); `400` for a `delete_data` that is not a boolean |
| `POST /v1/providers/{id}/login` | `{"method"?, "cols"?, "rows"?}` (`method` is an id from `login_methods`; absent means the first) | `201 {"session_id", "command", "pid"}` (`command` is the fallback text) | `404`; `409 login_unavailable` (the agent has no login command Octo can run, or it did not start; `command` is the text to run by hand); `409 agent_not_installed` / `agent_too_old` (the CLI is missing or too old: its install line is the `command`, no terminal is started) |
| `GET /v1/providers/{id}/login/{lid}/events` | SSE; `?token=` is accepted like on the other SSE routes | `output` `{"data": base64}`, `exit` `{"code", "reason"?}`, `login` `{"state": "ok" \| "not_logged_in" \| "unchecked"}` | `404` |
| `POST /v1/providers/{id}/login/{lid}/input` | `{"data"}` | `202` | `404` |
| `POST /v1/providers/{id}/login/{lid}/resize` | `{"cols", "rows"}` | `204` | `404` |
| `DELETE /v1/providers/{id}/login/{lid}` | none | `204` | `404` |

`account` is `{id, name, default, dir?, owned?}` (`id` is `""` for the default account, else the slug). `deleted_dir` is set only when `delete_data=true` was asked, the record says `owned`, its folder is exactly `{data-dir}/accounts/<agent>/<id>`, that folder is not a symlink and the folder it lies in still resolves (symlinks followed) to a place inside the real `{data-dir}/accounts`. Otherwise the record is removed, nothing is deleted and `deleted_dir` is `null` (a hand-edited record or a symlinked `accounts/<agent>` cannot make Octo delete anything else): **the CLI's own keychain entry, if it made one, is not removed**, and a folder you chose is never touched. Removing an account does not touch projects that name it; its model is then listed in `models_unavailable`.

**Login.** The route runs the manifest's `auth.login` command (a method per entry) in a PTY with the account's environment, in the account's folder (the home folder for a default account), under the pseudo-project `:agent-login`, so it never shows in a project's terminals or Processes tab. One login per agent id at a time (a new one closes the old). The output is shown as is and logged nowhere. While the process runs the harness rechecks the login (`Registry.Recheck`, the probe) every 5 s until a check says `ok`, and once more when the process exits; each result is a `login` event (`unchecked` when the agent has no probe or it could not tell, as for Gemini). A login is stopped after 10 minutes; the terminal manager's 5-minute idle close and its limits apply. After the `exit` event the stream waits up to 30 s for the last check. A changed probe publishes `providers.updated`.

### Additive fields

`GET /v1/providers` agent entries gain: `base_id` (always set), `account` (`{id, name, default, dir?, owned?}`, set whenever the base agent supports accounts; for a base entry it is the default account with its name), `accounts_support` (base entries: `{supported, reason?, note?}`; an agent without an `accounts` block reports `supported: false` with a generic reason), `login_methods` (`[{id, label}]`), `login_command` (the terminal command that logs this account in: for an account it starts with the folder variables, `CLAUDE_CONFIG_DIR='<folder>' claude auth login`) and `limit` (below). While a base agent has at least one other account its label reads `<label> · <default name>` and each account's `<label> · <name>`; accounts are listed directly after their base. `GET /v1/plugins` agents carry the same fields (`base_id`, `account`, `accounts_support`, `login_methods`, `login_command`, `limit`). An account's `hint` / `login_hint` is its own sentence ("Log in to this account with its own login command, not the default account's."), not the base agent's login text, and never names the folder.

**Paired devices get no folders.** `GET /v1/providers` and `GET /v1/plugins` are readable by a paired device, which cannot manage accounts or log in. A request that is not local (the same test as settings: loopback peer, loopback `Host`, no foreign `Origin`; a device arrives through the tunnel with the tunnel's host name) is answered without `account.dir`, `account.owned`, `login_command` (also `command` of `problem` and `models_problem`, which can hold the same line); everything else is unchanged. Local answers are unchanged. Test: `TestPairedDeviceGetsNoFoldersOrLoginCommands`.

**`experimental`** is `true` for an agent that is not verified (above) and also for one whose manifest says `"experimental": true`; the latter is never picked automatically (below). `GET /v1/plugins` agents carry `experimental: true` for the manifest flag only.

### Usage limits

`limit` is `{reached_at, resets_at?}` (RFC 3339). It is set when a real turn of that account ended in a limit failure (classification: [`acp-orchestrator.md`](acp-orchestrator.md#usage-limits-and-switching-accounts-2026-11-26)), and cleared by the next turn that runs, by **Check again** (`POST /v1/providers/{id}/recheck`) and when `resets_at` has passed. A bare 429 or `RATE_LIMIT_EXCEEDED` (a transient rate limit) fails the turn but does not set `limit`. It does not change `state`: the entry stays `ready`, and nothing is refused because of it. `providers.updated` follows a change.

### Who is offered work without being asked

An **experimental** agent (manifest `"experimental": true`, built in for `gemini`) and its accounts are offered only when a project's models name it, and `suggested` never proposes it ([`acp-orchestrator.md`](acp-orchestrator.md#usage-limits-and-switching-accounts-2026-11-26)). A non-default account is never picked automatically (spec: work and personal billing are the user's call). It is used only when a project's models name it (`orchestrator`, `fast`, `balanced`, `deep`, `side` or `auto_candidates`). Per base agent a project offers only the accounts its models name, and when they name none of them, only the default account. This covers the default orchestrator without a key, `suggested`, the router's `tier: auto` candidates and `spawn_agent`'s `agent` list. When an account is named, the base agent's other accounts are not offered unless they are named too.

### Which agents support accounts

A manifest agent supports accounts when it has an `accounts.env` block, and says why not otherwise (`accounts.unsupported`, or a generic reason). Built in: Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`), Devin (`XDG_DATA_HOME`: moves all of Devin's data, not only the login) and the experimental Gemini CLI (`GEMINI_CLI_HOME`, plus `GEMINI_FORCE_FILE_STORAGE=true` so the login is a file in the account folder and not a shared keychain entry). One account only: Antigravity, Copilot, Cursor, Grok, OpenCode, Droid, omp and pi, each with the reason from its manifest. The per-agent table is in the harness README.

**Not verified.** Accounts were exercised with the scripted agent (`internal/fakeacp`), shell-script login commands, unit tests, `scripts/e2e-accounts.sh` and the UI's demo bridge. No real CLI and no real account was used, and no live run is recorded. Not verified: that two Claude Code logins stay apart in the macOS Keychain per folder; each CLI's login inside Octo's terminal session; the real limit messages and where they arrive (a limit a CLI reports as plain answer text is not caught); the format of the reset time; Gemini's forced file storage; Devin's folder move.

## Event `providers.updated`

`{ "type": "providers.updated", "seq": n, "connected": 2 }` on every project stream (like `settings.changed`). Sent only when the picture changed (seen_at aside): a login probe changed its outcome, an account was added, renamed or removed, a usage limit was reached or cleared, a key or default model was written, an agent advertised new models, the router appeared or went away (re-read every 15 s). A client refetches `GET /v1/providers`. State: `providersRevision` in `@octo/agent-client`.

## Model checks

- `POST`/`PATCH /v1/projects` never refuse a model because its provider is not ready (since 2026-11-15; before, `422 model_unavailable` / `409 no_provider` with `can_force`). Unknown agents or models stay `400 invalid_request`. A project created with nothing ready keeps the server defaults.
- When `orchestrator` is an ACP agent (`acp:<id>[/<model>]`), Session mode aligns `fast`, `balanced`, and `deep` (and clears a stale cross-provider `side` override) to that same ACP provider (`project/input.go`, `project/service.go`), and `orchestrator/spawn.go` falls back to the ACP orchestrator's provider for sub-agent tiers.
- A new project's four models come from `suggested`, overlaid by what the request names.
- Reading never fails: `GET /v1/projects/{id}` lists unusable stored models in `models_unavailable: [{field, model, provider, reason}]` (always an array). A project whose orchestrator equals the server default while the built-in loop is off still runs on a ready agent (`EffectiveOrchestrator`); it is listed anyway.

## Connecting a key without a restart

`PUT /v1/settings` with `ANTHROPIC_API_KEY` applies at once (`applies: "now"`, not in `restart_required`): the Messages client and the router's route call read the key per request (`config.KeySource`), and the orchestrator's built-in-loop switch is swapped (`SetBuiltinUnavailable`), so `GET /v1/config` `builtin_loop`, `/v1/providers` and the next turn see it. Removing the key turns the loop off again. A key from the process environment (for example set by the desktop app for the bundled router) stays `editable: false`. `restart_required` still lists the router settings the desktop shell reads. A process that cannot swap its key (no `Applier.APIKey`, i.e. an embedder) keeps `applies: "restart"`.

## Failed turns and retry

- The orchestrator row keeps the turn's error (`agent.error`) and is `idle`; the project JSON has `attention`: `"needs_you"` (approval or form waiting), `"failed"` (last turn failed, nothing waiting), `"none"`. `project.attention` events carry `state: "failed"` and `error` when a turn fails and `state: "none"` when a retry starts.
- The UI's Retry posts the same text to `POST /v1/projects/{id}/messages`. If the orchestrator's last turn failed and its newest stored message is that very user message (nothing answered), the stored message is reused: no second user row, no `message.created`, the response carries the existing message, the open task record of the failed attempt continues. Otherwise the text is an ordinary new message. Every turn ends with `turn.finished` (`completed`, `failed` with the error, or `cancelled`).

## Not verified

No real agent CLI was run. Probe results, advertised models, discovery, typed models and logins were exercised with the scripted agent (`internal/fakeacp`, which can list models in each of the shapes above and log its requests) and fake probe and models commands. Only the owner's machine can say which of Claude Code, Codex, Grok and Copilot advertise models in `session/new` (and in which shape), what the real `grok models` prints (the built-in pattern is a guess, see the plugin README), whether the Claude aliases are what the CLI accepts, and whether each agent accepts a typed model.
