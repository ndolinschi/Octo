# harness

Go agent harness (`github.com/ndolinschi/Octo/harness`): Anthropic Messages tool loop with local workspace tools, optional remote HTTP tools, and its own SQLite session store. Talks to any Anthropic-compatible Messages endpoint — typically [Octo](../README.md) on loopback.

Product architecture: [docs/architecture.md](./docs/architecture.md).

## Security: `bash` is not sandboxed

The **`bash`** tool runs real shell commands as the user running the harness. It can access any path, network, and secret that user can — workspace path checks apply only to `read_file`, `write_file`, and `list_dir`, not to arbitrary commands. Do not run the harness on secrets you would not give to an interactive shell.

## Prerequisites

- Go 1.26+
- `ANTHROPIC_API_KEY` (sent upstream; for Octo, use the same key your client would send to Messages)

## Build

```bash
cd harness
go build -o octo-harness ./cmd/harness
```

## Test

```bash
cd harness
go test ./...
```

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

Streaming assistant text is written to **stderr** during `run`; final assistant text is printed to stdout. Errors go to stderr with exit code 1.

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

- `harness.sqlite` — sessions and message JSON
- `cache/` — cached remote tool manifests

Harness data is separate from Octo Rust `data/history.sqlite`.

## Local tools and workspace

`read_file`, `write_file`, and `list_dir` resolve paths under `--workspace` only (symlink escape rejected). `bash` is documented above: full host shell, not a sandbox. Path checks for file tools happen at resolve time, not again at open/read/write (TOCTOU). Tool stdout and file reads are capped at 1 MiB (`\n...truncated` when clipped).
