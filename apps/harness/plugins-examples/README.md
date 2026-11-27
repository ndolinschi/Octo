# Plugin examples

Plugins connect local programs to the harness: language servers, ACP agents and tool servers. A plugin is a directory with a `plugin.json`. The harness reads plugins at startup from

- `{data-dir}/plugins/*/plugin.json`, and
- every `--plugins-dir` (repeatable; also `HARNESS_PLUGINS_DIR`, path-list separated). A `--plugins-dir` may be a plugin directory itself or a directory of plugin directories.

Nothing in this folder is loaded from disk automatically, with one exception: `subscription-agents/plugin.json` is also embedded in the harness binary and loaded as a built-in plugin (a plugin of the same name from the places above replaces it; `--no-builtin-plugins` turns it off). The harness never writes plugins and has no API to add one: installing a plugin is a local file operation, because a manifest names commands the harness will run **with your privileges**.

```bash
go run ./cmd/harness serve --plugins-dir plugins-examples/fake-acp --plugins-dir plugins-examples/go-tools
curl localhost:8790/v1/plugins
```

## Manifest

```jsonc
{
  "name": "go-tools",          // required; [a-z0-9] words joined by '-'
  "version": "1.0.0",          // required
  "description": "...",
  "languageServers": [{ "id": "gopls", "label": "gopls", "languages": ["go"], "command": "gopls", "args": [], "env": {} }],
  "agents":          [{ "id": "claude-code", "label": "Claude Code", "command": "npx", "args": ["-y", "..."], "env": {} }],  // + optional model and auth fields below
  "toolServers":     [{ "url": "http://127.0.0.1:9000" }]   // same contract as --remote, sub-agents only
}
```

- `command`: absolute path as is; a value containing a path separator is relative to the plugin directory; anything else is looked up on `PATH`. `available` in the API means the command resolves to an executable.
- Agent extras (all optional; manifests without them load unchanged):
  - `models` (list of model ids) and `defaultModel` (must be in `models` when both are given): `spawn_agent` offers `model`, validated against the list, and the harness records the agent as `acp:<id>/<model>` (`acp:<id>` when none applies). The model is selected through what the agent advertises over ACP (a model config option, else `session/set_model`). A model the orchestrator asked for that cannot be selected fails the sub-agent; the manifest default is best effort. Model ids must match `[A-Za-z0-9][A-Za-z0-9._:/@+-]*` (they end up in process arguments).
  - `modelArg`: argument template for CLIs that take the model at start-up, e.g. `["-m", "{model}"]`; it is appended to `args` when a model applies. To place it elsewhere, put the literal element `"{modelArgs}"` in `args` (at most once, and only with a `modelArg`): the expanded template is spliced there and the element is dropped when no model is chosen. Example (Grok wants `-m` before `stdio`): `"args": ["agent", "{modelArgs}", "stdio"], "modelArg": ["-m", "{model}"]`.
  - `auth`: `{ "probe": ["cmd", "arg"], "hint": "one line", "methods": [...], "skip": [...] }`. The probe must exit 0 when the CLI is logged in and must never log in or start a session; it runs in the background (when `GET /v1/plugins` is called, at most once a minute per agent, 5 s timeout, never on the request path) and its output is discarded. `GET /v1/plugins` then reports `logged_in` (`true`, `false`, or `null` without a probe or result), `models`, `default_model` and `hint`. Without a probe the hint is still shown, and a sub-agent whose agent refuses the session and offers only interactive login fails with the hint in its error.
  - `flatRate` (bool, default `false`): the agent runs on a flat-rate subscription, so a task on it costs nothing at the margin. Sent to the router as `flat_rate` when the harness asks who should do a delegated task. `strengths` (a list of `easy`, `medium`, `hard`; default none): the difficulty bands the agent suits, sent as `strengths`. Both are reported by `GET /v1/plugins` (`flat_rate`, `strengths`). `requires` (list of command names, optional): commands that must be on PATH besides `command` for the agent to count as available (an adapter run through `npx` that drives a separately installed CLI); a missing one makes `available` false and `unavailable_reason` says which.
  - `version` (optional, `{"command": ["agy", "--version"], "min": "1.5.0"}`): a command that prints the CLI's version and the lowest version the launch command works with. The harness runs it in the background (at most every 10 minutes, killed after 5 s, in the user's home with the child environment; "Check again" / `POST /v1/providers/{id}/recheck` runs it now) and reads the first dotted number of its output. Only a version that was read and is lower than `min` counts: the agent is then `available: false` with `unavailable_reason` "agy 1.4.12 is installed; Octo needs 1.5.0 or newer", `GET /v1/providers` lists it `not_installed` with the problem `AgentTooOld` (message, the install line as command, "Check again"), and `harness doctor` prints the version line. Output without a number, a failure or a timeout never makes an agent unavailable. `mcpTransport` (`"auto"`, the default, or `"stdio"`): `stdio` hands the harness's tool server to the agent over the stdio relay even when it advertises HTTP MCP. `searchPaths` (list of absolute folders or `~/...`): where the agent's `command` is looked for when PATH does not have it (the vendor's default install folder; an app started from the Dock may lack it in PATH); the version command is resolved the same way.
  - `auth.methods` and `auth.skip` steer the ACP `authenticate` call the harness makes when an agent that advertised auth methods refuses `session/new`. `methods` is the preference order of method ids; each entry is a string (`"cached_token"`) or `{"id": "factory-api-key", "requiresEnv": "FACTORY_API_KEY"}`, which is tried only while that variable is set (non-empty) in the agent's environment (after the scrub and the manifest `env`). With `methods` set only those are tried, in that order, even if the agent offers others; a method of type `terminal` is never tried. `skip` lists ids that are never tried. Without `methods` the default stays: every advertised method that needs no interaction, in the agent's order, except those whose id contains `device`, `pairing`, `terminal`, `browser` or `login` (or whose description says browser, terminal, interactive, pairing or device code). If nothing usable remains the sub-agent fails with the reasons and the hint.
  - `accounts` (2026-11-26): how a second login of the CLI is kept apart. `{"env": {"CLAUDE_CONFIG_DIR": "{dir}"}, "note": "..."}`: the environment variables the CLI documents for its login folder; `{dir}` is replaced by the account's folder, at least one value must contain it, names must be valid variable names and `${NAME}` is not allowed. `note` is shown beside the accounts. Or `{"unsupported": "<reason>"}` for a CLI that cannot do it (it excludes `env`); the reason is shown to the user. Without an `accounts` block the agent is "one account only" with a generic reason. The account's variables are laid over the agent's `env` for that account only.
  - `auth.login` (2026-11-26): `[{"id": "claudeai", "label": "Claude subscription", "args": ["claude", "auth", "login", "--claudeai"]}]`: interactive commands that log the CLI in, one per method (unique ids, `args[0]` the program, resolved like the agent's own command). The Log in button runs the first, or the chosen one, in a terminal session with the account's environment; `auth.command` stays the text shown for a terminal of your own. `auth` may hold just `login`.
  - `limitPatterns` (2026-11-26): regular expressions (Go syntax) matched against the agent's error message; a match marks the failure as a usage limit (`agent_limit_reached`). Built in for Claude Code and Codex only.
  - `experimental` (2026-11-26, boolean, default false): the agent is listed and can be chosen by hand, but is never picked automatically: it is offered to the orchestrator, `spawn_agent`, automatic routing and the no-key fallback orchestrator only when the project's models name it. Set on the built-in `gemini`. It cannot be combined with `unsupported`.
  - `env` values may use `${NAME}`, resolved from the harness's own environment when the agent (or probe) starts. If any referenced variable is unset or empty, that entry is left out; it is never passed as an empty string. The process otherwise gets the harness's environment **minus** provider settings (`ANTHROPIC_*`, `OPENAI_*`, `XAI_*`, `GROK_CODE_*`, `GEMINI_*`, `GOOGLE_GENAI_*`, `GOOGLE_API_KEY`, `OPENROUTER_*`, `HARNESS_*`, `*_BASE_URL`, `*_API_BASE`, and the Octo router secrets); `env` is applied after that removal, so listing `"XAI_API_KEY": "${XAI_API_KEY}"` is how a manifest passes a key on purpose. The same scrub applies to ACP agents, language servers and login probes.
- Ids must be unique across plugins (per kind). The first plugin loaded wins; later duplicates are listed in that plugin's `errors` (since 2026-11-26 the shipped `acp-agents` and `subscription-agents` both define `gemini`, so loading both reports a duplicate in the later plugin's `errors`; load only one of them). A malformed manifest yields an entry with `errors` and no capabilities; startup never fails because of a plugin.
- `languages` are Monaco language ids.

## Examples

| Directory | What it needs |
| --- | --- |
| `fake-acp` | The scripted agent, built once: `go build -o plugins-examples/fake-acp/bin/fakeacp ./examples/fakeacp` (from `apps/harness`). No model, no network. Since 0.2.0 it has an `accounts` block, a login probe (`fakeacp status`) and a login command (`fakeacp login`), so accounts, the Log in button and the limit markers `[limit:rpc]` and `[limit:agent_error]` can be tried without a real CLI. |
| `go-tools` | `gopls` on `PATH` (`go install golang.org/x/tools/gopls@latest`). |
| `typescript-tools` | `typescript-language-server` on `PATH` (`npm i -g typescript typescript-language-server`). |
| `acp-agents` | Gemini CLI via `gemini --acp`. **An example:** the exact package name, flags and login steps change; check the tool's own documentation (and the [ACP registry](https://agentclientprotocol.com)) before relying on it. Claude Code moved to `subscription-agents`. Since 2026-11-26 `subscription-agents` has its own `gemini` entry (experimental, with accounts); this example keeps the same id, so do not load both. |
| `subscription-agents` | Twelve agent CLIs, each running on the subscription its own CLI is logged in to: Claude Code, GitHub Copilot, Grok, Codex, Cursor, OpenCode, Antigravity, the experimental Gemini CLI, Devin, Factory Droid, Oh My Pi and Pi. Needs the CLIs installed and logged in; see the harness README, "Running on subscriptions", for the table of commands, logins and env vars. **Only the scripted agent has been run here**: the entries other than Copilot, Grok and Codex are unverified, and no entry has been run with a second account. None of the manifests lists models: each agent advertises its own over ACP. Probes exist only for Claude Code, Codex, Cursor and Devin. |

## Try the whole path without a model

```bash
go build -o plugins-examples/fake-acp/bin/fakeacp ./examples/fakeacp
go run ./examples/mockllm &                                    # 127.0.0.1:8791
ANTHROPIC_API_KEY=mock go run ./cmd/harness serve --base-url http://127.0.0.1:8791 \
  --data-dir /tmp/octo-data --plugins-dir plugins-examples/fake-acp
```

Create a project on a folder with a `README.md` and post `[acp] summarize this repo`: the mock orchestrator delegates to the `fake` agent, which streams text, reads `README.md`, asks permission, writes `acp-demo-note.md` and reports back. Add `[hang]`, `[crash]`, `[escape]` or `[unknown]` to the message to see cancellation, a failing agent, a refused out-of-project read, or unknown protocol messages.

## Trust

ACP agents are separate programs running as you. The harness auto-approves their permission requests and serves their file requests only inside the project's folders, but the agent process itself is not sandboxed.
