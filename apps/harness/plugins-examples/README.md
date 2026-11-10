# Plugin examples

Plugins connect local programs to the harness: language servers, ACP agents and tool servers. A plugin is a directory with a `plugin.json`. The harness reads plugins at startup from

- `{data-dir}/plugins/*/plugin.json`, and
- every `--plugins-dir` (repeatable; also `HARNESS_PLUGINS_DIR`, path-list separated). A `--plugins-dir` may be a plugin directory itself or a directory of plugin directories.

Nothing in this folder is loaded automatically. The harness never writes plugins and has no API to add one: installing a plugin is a local file operation, because a manifest names commands the harness will run **with your privileges**.

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
  - `modelArg`: argument template for CLIs that take the model at start-up, e.g. `["-m", "{model}"]`; it is appended to `args` when a model applies.
  - `auth`: `{ "probe": ["cmd", "arg"], "hint": "one line" }`. The probe must exit 0 when the CLI is logged in and must never log in or start a session; it runs in the background (when `GET /v1/plugins` is called, at most once a minute per agent, 5 s timeout, never on the request path) and its output is discarded. `GET /v1/plugins` then reports `logged_in` (`true`, `false`, or `null` without a probe or result), `models`, `default_model` and `hint`. Without a probe the hint is still shown, and a sub-agent whose agent refuses the session and offers only interactive login fails with the hint in its error.
  - `env` values may use `${NAME}`, resolved from the harness's own environment when the agent (or probe) starts. If any referenced variable is unset or empty, that entry is left out; it is never passed as an empty string.
- Ids must be unique across plugins (per kind). The first plugin loaded wins; later duplicates are listed in that plugin's `errors`. A malformed manifest yields an entry with `errors` and no capabilities; startup never fails because of a plugin.
- `languages` are Monaco language ids.

## Examples

| Directory | What it needs |
| --- | --- |
| `fake-acp` | The scripted agent, built once: `go build -o plugins-examples/fake-acp/bin/fakeacp ./examples/fakeacp` (from `apps/harness`). No model, no network. |
| `go-tools` | `gopls` on `PATH` (`go install golang.org/x/tools/gopls@latest`). |
| `typescript-tools` | `typescript-language-server` on `PATH` (`npm i -g typescript typescript-language-server`). |
| `acp-agents` | Claude Code via `npx -y @agentclientprotocol/claude-agent-acp` and Gemini CLI via `gemini --acp`. **These two are examples:** the exact package names, flags and login steps change; check each tool's own documentation (and the [ACP registry](https://agentclientprotocol.com)) before relying on them. |
| `subscription-agents` | GitHub Copilot (`copilot --acp --stdio`), Grok (`grok agent stdio`) and Codex (`npx -y @agentclientprotocol/codex-acp`), each running on the subscription its own CLI is logged in to. Needs the CLIs installed and logged in; see the harness README, "Running on subscriptions". None of the manifests lists models: each agent advertises its own over ACP; add `models`/`defaultModel` if you want `spawn_agent` to offer a fixed list. Only Codex has a probe (`codex login status`, check it against your Codex version); Copilot and Grok publish no documented non-interactive status command, so their `logged_in` stays `null`. |

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
