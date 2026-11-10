# harness

Go agent harness (`github.com/ndolinschi/Octo/apps/harness`): Anthropic Messages tool loop with local workspace tools, optional remote HTTP tools, a project server (`harness serve`: orchestrator + nested sub-agents over HTTP/SSE), and its own SQLite stores. Talks to any Anthropic-compatible Messages endpoint — typically [Octo](../router/README.md) on loopback.

Product architecture: [docs/architecture.md](./docs/architecture.md).

## Security: `bash` is not sandboxed

The **`bash`** tool runs real shell commands as the user running the harness. It can access any path, network, and secret that user can — workspace path checks apply only to `read_file`, `write_file`, and `list_dir`, not to arbitrary commands. Do not run the harness on secrets you would not give to an interactive shell.

## Prerequisites

- Go 1.26+ (`bash scripts/install-go-toolchain.sh` from the monorepo root)
- `ANTHROPIC_API_KEY` (sent upstream; for Octo, use the same key your client would send to Messages)

Coding standards (agents/editors): `.cursor/rules/octo-go.mdc`, `go-pr-checklist.mdc`, `verify-go.mdc`.

## Build

```bash
cd apps/harness
go vet ./...
go test ./...
go build -o octo-harness ./cmd/harness
```

## Serve (projects, no API key needed with mockllm)

```bash
go run ./examples/mockllm                       # scripted Messages server on 127.0.0.1:8791
ANTHROPIC_API_KEY=mock go run ./cmd/harness serve --base-url http://127.0.0.1:8791 --data-dir /tmp/octo-data
```

Then `curl -XPOST localhost:8790/v1/projects -d '{"name":"Demo","folders":[{"path":"'$PWD'"}]}'`, post a message to `/v1/projects/{id}/messages`, follow `/v1/projects/{id}/events`, and browse or edit project files via `/v1/projects/{id}/files` (see [`docs/architecture.md`](docs/architecture.md#file-api)). API contract: [`docs/superpowers/specs/2026-11-10-project-harness-design.md`](../../docs/superpowers/specs/2026-11-10-project-harness-design.md). Against a real endpoint, drop `--base-url` (or point it at Octo) and set a real key.

`serve` flags: `--addr` (default `127.0.0.1:8790`), `--data-dir`, `--base-url`, `--octo-key`, `--remote` (repeatable, sub-agents only), `--plugins-dir` (repeatable), `--max-turns`. Tier models come from `HARNESS_MODEL_ORCHESTRATOR|FAST|BALANCED|DEEP` or per project. Say "quick" in a message to make mockllm answer without delegating.

## Plugins and ACP agents

Plugins are local directories with a `plugin.json` naming language servers, [Agent Client Protocol](https://agentclientprotocol.com) agents and tool servers. They are read at startup from `{data-dir}/plugins/*/plugin.json` and from `--plugins-dir` (repeatable) / `HARNESS_PLUGINS_DIR`; `GET /v1/plugins` lists them with `available` flags and manifest `errors`. There is no endpoint to add a plugin.

### Language servers (gopls)

Enable gopls for the editor by pointing `--plugins-dir` at the example plugin (needs `gopls` on `PATH`: `go install golang.org/x/tools/gopls@latest`):

```bash
ANTHROPIC_API_KEY=mock go run ./cmd/harness serve --base-url http://127.0.0.1:8791 --plugins-dir plugins-examples/go-tools
curl localhost:8790/v1/projects/{id}/lsp                                  # gopls: available true
curl -XPOST localhost:8790/v1/projects/{id}/lsp/gopls/sessions            # {session_id, root_uri, workspace_folders}
curl -N localhost:8790/v1/projects/{id}/lsp/sessions/{sid}/events         # SSE: server -> client messages
curl -XPOST localhost:8790/v1/projects/{id}/lsp/sessions/{sid}/messages -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
```

The harness only relays framed JSON-RPC (8 sessions per project, 4 MiB per message; idle sessions are reaped after 30 s without an event stream); see [`docs/architecture.md`](docs/architecture.md#language-servers).

With an available ACP agent, `spawn_agent` gains an `agent` parameter and the orchestrator can delegate a task to that external agent; its text, tool calls and file edits appear in the normal sub-agent transcript. Demo without any model or agent install:

```bash
go build -o plugins-examples/fake-acp/bin/fakeacp ./examples/fakeacp
go run ./examples/mockllm                                # 127.0.0.1:8791
ANTHROPIC_API_KEY=mock go run ./cmd/harness serve --base-url http://127.0.0.1:8791 --plugins-dir plugins-examples/fake-acp
# create a project on a folder with a README.md, then post: "[acp] summarize this repo"
```

Manifest format and more examples (gopls, TypeScript, Claude Code, Gemini CLI): [`plugins-examples/README.md`](plugins-examples/README.md).

**Trust:** an ACP agent is a separate program that runs with your user's privileges. The harness **auto-approves** its permission requests and serves its file requests only inside the project's folders; the agent process itself is not sandboxed, and a plugin manifest is a list of commands the harness will run. Only install plugins you trust.

## Run (direct Messages through Octo)

Start Octo from the repo root (`cargo run`, default `127.0.0.1:8080`), then:

```bash
export ANTHROPIC_API_KEY="your-key"
./octo-harness run \
  --prompt "List files in the workspace" \
  --workspace /path/to/repo \
  --base-url http://127.0.0.1:8080 \
  --model claude-sonnet-4-5
```

Octo uses `[llm.messages]` routing; the SDK posts to `{base-url}/v1/messages`.

## Run (Octo autoroute)

Same API key and loopback host; point the base URL at autoroute so Octo applies ladder / sticky / budget routing:

```bash
export ANTHROPIC_API_KEY="your-key"
./octo-harness run \
  --prompt "Summarize README.md" \
  --workspace . \
  --base-url http://127.0.0.1:8080/autoroute \
  --model claude-sonnet-4-5
```

## Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--prompt` | (required) | User message for the session |
| `--workspace` | `.` | Root for `bash`, `read_file`, `write_file`, `list_dir` |
| `--base-url` | `ANTHROPIC_BASE_URL` env | Empty uses Anthropic SDK default |
| `--model` | `claude-sonnet-4-5` | Upstream model id; autoroute may rewrite |
| `--data-dir` | `./data/harness` or `HARNESS_DATA_DIR` | SQLite + remote tool cache |
| `--remote` | (repeatable) | `GET {base}/tools` discovery + invoke |
| `--max-turns` | `HARNESS_MAX_TURNS` or 25 | Cap tool-loop turns |
| `--octo-key` | `HARNESS_OCTO_KEY` | Sent as `x-octo-key` when Octo `client_auth_key` is set |
| `--stream` | `HARNESS_STREAM` or true | Stream assistant text deltas to stderr |

When `--stream` is on, assistant text and `session: <id>` are written to **stderr** during `run`; final assistant text is printed to stdout. Errors go to stderr with exit code 1.

## Session inspection

```bash
./octo-harness sessions
./octo-harness show <session-id>
```

Both accept `--data-dir` (same default as `run`).

## Remote tools

Example echo server:

```bash
go run ./examples/remotetool
# harness run ... --remote http://127.0.0.1:9100
```

## Data layout

Under `--data-dir` (default `./data/harness`):

- `harness.sqlite` — legacy CLI sessions and message JSON
- `registry.sqlite` — project index (`serve`)
- `projects/{id}/project.sqlite` — everything for one project: folders, agents, messages, notes
- `cache/` — cached remote tool manifests

Harness data is separate from Octo Rust `data/history.sqlite`.

## Local tools and workspace

`read_file`, `write_file`, and `list_dir` resolve paths under `--workspace` only (symlink escape rejected). Under `serve`, they resolve under the project's attached folders (optional `folder` label per call); `bash` runs with the chosen folder as cwd and is equally unsandboxed. `bash` is documented above: full host shell, not a sandbox. Path checks for file tools happen at resolve time, not again at open/read/write (TOCTOU). Tool stdout and file reads are capped at 1 MiB (`\n...truncated` when clipped).
