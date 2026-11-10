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
  "agents":          [{ "id": "claude-code", "label": "Claude Code", "command": "npx", "args": ["-y", "..."], "env": {} }],
  "toolServers":     [{ "url": "http://127.0.0.1:9000" }]   // same contract as --remote, sub-agents only
}
```

- `command`: absolute path as is; a value containing a path separator is relative to the plugin directory; anything else is looked up on `PATH`. `available` in the API means the command resolves to an executable.
- Ids must be unique across plugins (per kind). The first plugin loaded wins; later duplicates are listed in that plugin's `errors`. A malformed manifest yields an entry with `errors` and no capabilities; startup never fails because of a plugin.
- `languages` are Monaco language ids.

## Examples

| Directory | What it needs |
| --- | --- |
| `fake-acp` | The scripted agent, built once: `go build -o plugins-examples/fake-acp/bin/fakeacp ./examples/fakeacp` (from `apps/harness`). No model, no network. |
| `go-tools` | `gopls` on `PATH` (`go install golang.org/x/tools/gopls@latest`). |
| `typescript-tools` | `typescript-language-server` on `PATH` (`npm i -g typescript typescript-language-server`). |
| `acp-agents` | Claude Code via `npx -y @zed-industries/claude-code-acp` and Gemini CLI via `gemini --acp`. **These two are examples:** the exact package names, flags and login steps change; check each tool's own documentation before relying on them. |

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
