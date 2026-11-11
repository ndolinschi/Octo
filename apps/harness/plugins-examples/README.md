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
  - `auth.methods` and `auth.skip` steer the ACP `authenticate` call the harness makes when an agent that advertised auth methods refuses `session/new`. `methods` is the preference order of method ids; each entry is a string (`"cached_token"`) or `{"id": "factory-api-key", "requiresEnv": "FACTORY_API_KEY"}`, which is tried only while that variable is set (non-empty) in the agent's environment (after the scrub and the manifest `env`). With `methods` set only those are tried, in that order, even if the agent offers others; a method of type `terminal` is never tried. `skip` lists ids that are never tried. Without `methods` the default stays: every advertised method that needs no interaction, in the agent's order, except those whose id contains `device`, `pairing`, `terminal`, `browser` or `login` (or whose description says browser, terminal, interactive, pairing or device code). If nothing usable remains the sub-agent fails with the reasons and the hint.
  - `env` values may use `${NAME}`, resolved from the harness's own environment when the agent (or probe) starts. If any referenced variable is unset or empty, that entry is left out; it is never passed as an empty string. The process otherwise gets the harness's environment **minus** provider settings (`ANTHROPIC_*`, `OPENAI_*`, `XAI_*`, `GROK_CODE_*`, `GEMINI_*`, `GOOGLE_GENAI_*`, `GOOGLE_API_KEY`, `OPENROUTER_*`, `HARNESS_*`, `*_BASE_URL`, `*_API_BASE`, and the Octo router secrets); `env` is applied after that removal, so listing `"XAI_API_KEY": "${XAI_API_KEY}"` is how a manifest passes a key on purpose. The same scrub applies to ACP agents, language servers and login probes.
- Ids must be unique across plugins (per kind). The first plugin loaded wins; later duplicates are listed in that plugin's `errors` (the shipped `acp-agents` and `subscription-agents` share no id, so loading both is clean). A malformed manifest yields an entry with `errors` and no capabilities; startup never fails because of a plugin.
- `languages` are Monaco language ids.

## Examples

| Directory | What it needs |
| --- | --- |
| `fake-acp` | The scripted agent, built once: `go build -o plugins-examples/fake-acp/bin/fakeacp ./examples/fakeacp` (from `apps/harness`). No model, no network. |
| `go-tools` | `gopls` on `PATH` (`go install golang.org/x/tools/gopls@latest`). |
| `typescript-tools` | `typescript-language-server` on `PATH` (`npm i -g typescript typescript-language-server`). |
| `acp-agents` | Gemini CLI via `gemini --acp`. **An example:** the exact package name, flags and login steps change; check the tool's own documentation (and the [ACP registry](https://agentclientprotocol.com)) before relying on it. Claude Code moved to `subscription-agents`. |
| `subscription-agents` | Eleven agent CLIs, each running on the subscription its own CLI is logged in to: Claude Code, GitHub Copilot, Grok, Codex, Cursor, OpenCode, Antigravity, Devin, Factory Droid, Oh My Pi and Pi. Needs the CLIs installed and logged in; see the harness README, "Running on subscriptions", for the table of commands, logins and env vars. **Only the scripted agent has been run here**: the entries other than Copilot, Grok and Codex are unverified. None of the manifests lists models: each agent advertises its own over ACP. Probes exist only for Claude Code, Codex, Cursor and Devin. |

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
