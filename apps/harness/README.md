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

`serve` flags: `--addr` (default `127.0.0.1:8790`), `--data-dir`, `--base-url`, `--octo-key`, `--remote` (repeatable, sub-agents only), `--plugins-dir` (repeatable), `--max-turns`. Tier models come from `HARNESS_MODEL_ORCHESTRATOR|FAST|BALANCED|DEEP` or per project. Defaults: orchestrator `claude-sonnet-5-5` (the balanced model; it was opus before 2026-11-10 because the longest-lived thread should not run on the dearest model; projects created earlier keep their stored models), fast `claude-haiku-5-5`, balanced `claude-sonnet-5-5`, deep `claude-opus-5-5`. Say "quick" in a message to make mockllm answer without delegating.

### Cost controls

- **Prompt caching** (`--prompt-caching`, `HARNESS_PROMPT_CACHING`, default on): requests carry `cache_control` breakpoints on the last tool, the last system block and the last message block, so each loop iteration reads the conversation so far from the cache instead of paying full input price. Turn it off (`--prompt-caching=false`) for a gateway that rejects the field. Cache tokens appear in `/v1/usage` as `cache_read_tokens` / `cache_write_tokens`.
- **Result caps** (what goes back into model context, not the UI file API): tool results 48 KiB (`HARNESS_MAX_TOOL_RESULT_BYTES`), sub-agent reports 32 KiB (`HARNESS_MAX_REPORT_BYTES`), `read_file` 2000 lines by default (`HARNESS_READ_FILE_LINES`; the tool takes `offset` and `limit`). A cut result says how much was cut and how to get the rest.
- **mockllm** simulates the cache: with breakpoints it reports `cache_creation_input_tokens` for new prefix and `cache_read_input_tokens` for a prefix an earlier request wrote (matched by content hash, ignoring the markers, with the real API's 20-block lookback); without breakpoints both are 0. Its token counts are synthetic (a quarter byte per character plus a fixed overhead per message and tool) and it has no minimum cacheable length.

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

For GitHub Copilot, Grok and Codex on a subscription, see [Running on subscriptions](#running-on-subscriptions).

**Trust:** an ACP agent is a separate program that runs with your user's privileges. The harness **auto-approves** its permission requests and serves its file requests only inside the project's folders; the agent process itself is not sandboxed, and a plugin manifest is a list of commands the harness will run. Only install plugins you trust.

## Running on subscriptions

The supported way to use a Copilot, Grok or ChatGPT/Codex subscription is to run the vendor's own agent CLI, which the harness drives over ACP as a sub-agent (design: [`docs/superpowers/specs/2026-11-10-subscription-agents-design.md`](../../docs/superpowers/specs/2026-11-10-subscription-agents-design.md)). Nothing is proxied and the harness never reads a vendor's credential files: the CLI finds its own login, and the harness only runs the commands in the manifest.

1. Install and log in to each CLI you want, following the vendor's documentation (commands change between versions, so they are not copied here):
   - GitHub Copilot CLI: [GitHub Copilot docs](https://docs.github.com/en/copilot) (search for the Copilot CLI). Its ACP mode (`copilot --acp --stdio`) is in public preview. Headless login: a fine-grained personal access token with the **Copilot Requests** permission in `COPILOT_GITHUB_TOKEN` (the CLI's documentation describes creating it). Start the harness with that variable set and the manifest forwards it (`"COPILOT_GITHUB_TOKEN": "${COPILOT_GITHUB_TOKEN}"`).
   - Grok CLI (`grok agent stdio`): [xAI docs](https://docs.x.ai). Log in with the CLI. `XAI_API_KEY` is the documented headless path but is billed per token, not on the subscription, and the harness does not copy the CLI's own login file.
   - Codex: [OpenAI docs](https://developers.openai.com/codex). The example runs the adapter `@agentclientprotocol/codex-acp` through `npx`, which needs Node.js; log in with the Codex CLI (`codex login`, or its device-code option on a headless machine).
2. Load the example plugin: `go run ./cmd/harness serve --plugins-dir plugins-examples/subscription-agents`. Copy and edit the manifest to change commands, add `models`, or add an `auth.probe`; nothing in `plugins-examples` loads by itself.
3. `GET /v1/plugins` shows each agent with `available` (command found), `logged_in` (`true`/`false`, or `null` when the manifest has no probe or it has not run yet) and the manifest `hint`. In a project, ask the orchestrator to delegate to the agent, optionally naming a model; a CLI that is logged out fails that sub-agent with the hint in its error and the orchestrator carries on.

**`CODEX_HOME` isolation.** Codex keeps its login and state in `$CODEX_HOME` (default `~/.codex`). The example manifest sets `CODEX_HOME` from `OCTO_CODEX_HOME`, so starting the harness with `OCTO_CODEX_HOME=/path/to/dir` gives the harness its own Codex home; log in once with `CODEX_HOME=/path/to/dir codex login` and the sub-agent and the probe both use that folder. Without `OCTO_CODEX_HOME` the entry is left unset and Codex uses its default.

**What a run costs.** Sub-agent runs are charged to the plan, not to an API key: a Copilot run consumes premium requests (model multipliers apply, see GitHub's billing page), Grok and Codex runs count against the subscription's usage limits, and all three can be rate-limited or refused when a limit is hit (the error shows in the sub-agent). The harness records the agent as `acp:<id>[/<model>]` and shows token and cost figures only when the agent reports them in `usage_update`; plan usage is not readable from here. The orchestrator itself still calls the Messages API configured with `--base-url`, which is billed as before.

**Live tests.** They are off by default, need the real CLIs and use a little quota. One sub-agent per CLI reads a marker file in a temporary project and answers; the test checks for an assistant message, the marker (or a tool call on that file) and a clean completion. A missing CLI or a logged-out probe skips the test and prints why.

```bash
scripts/test-subscriptions.sh                 # copilot, grok, codex
scripts/test-subscriptions.sh codex           # only Codex
# or directly
OCTO_TEST_COPILOT=1 go test -tags subscription ./internal/orchestrator -run TestSubscriptionAgents -v
```

Without the `subscription` build tag, or without the `OCTO_TEST_*=1` switches, `go test ./...` never starts any of these CLIs.

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

## Usage, cost and limits

Spec: [`2026-11-10-usage-design.md`](../../docs/superpowers/specs/2026-11-10-usage-design.md) (Phase A).

- `GET /v1/usage?from=&to=&group=day|model|project|agent&project=` sums per-request usage rows (input, output, cache read and cache write tokens, request count, cost) across all projects, or one with `project=`. `from`/`to` are RFC 3339 or `YYYY-MM-DD` (UTC; `to` exclusive; default the last 30 days); `group` defaults to `day`. Days without usage are omitted, an empty range returns empty `buckets`, bad parameters return 400 and an unknown `project` 404. `total` is the sum of the buckets. Usage is recorded from the migration on; earlier history is not back-filled.
- `GET /v1/limits` returns `{"limits":[{provider, model, kind, limit, remaining, resets_at, observed_at}]}`: the latest rate-limit headers the base URL's host returned (`anthropic-ratelimit-*`, else `x-ratelimit-*`; duration resets such as `6m0s` become RFC 3339 using the observation time), one entry per provider host, model and kind. Held in memory, so the list is empty after a restart or while no response carried such headers. mockllm sends Anthropic-style headers by default; `go run ./examples/mockllm -ratelimit openai` sends `x-ratelimit-*` ones, `-ratelimit none` none.
- Cost: a source-reported cost (an ACP agent's `usage_update.cost` in USD, as the increase since its previous update) is summed as is. API usage is estimated as tokens x price from the optional `{data-dir}/prices.toml` (read at startup; never the router's price file). A bucket's `cost_usd` is `null` when nothing in it has a price, `cost_estimated` is true when any part came from the table, and models missing from the table contribute nothing rather than zero. Cache prices are optional; a model without `cache_read` / `cache_write` is estimated at 0.1x and 1.25x its input price (Anthropic's published ratios; a default assumption, not data, and an explicit price always overrides it).

```toml
[models."claude-opus-5-5"]
input = 5.0        # USD per 1M tokens
output = 25.0
cache_read = 0.5   # optional; default 0.1 x input
cache_write = 6.25 # optional; default 1.25 x input
```

The file is a small TOML subset (`[models."id"]` tables, `key = number`, `#` comments) read by the harness itself. A malformed file is logged and treated as missing.

ACP agents also report context occupancy: `context_used` and `context_size` on the agent (null until the agent sends a `usage_update`).

**Not read:** subscription plan limits (Claude Pro/Max, ChatGPT Plus/Pro, Google AI plans). No documented programmatic source exists for them, so the harness neither reads CLI credentials nor calls undocumented endpoints; those limits are shown by the agent's own CLI. OpenRouter key info is not polled in Phase A.

## Octo router integration (I1)

When `--base-url` points at an Octo router (detected through `GET /health`; use the `/autoroute` path), the harness sends hints (`x-octo-budget-key`, `-agent-role`, `-agent-depth`, `-tier-hint`, `-tier-policy`, `-task`, `-budget-usd`), records the served model, tier, trigger and the router's cost per request, enforces the project's budget and applies router compactions. Details: [`docs/architecture.md`](docs/architecture.md#working-with-the-octo-router). Check it end to end with `bash scripts/e2e-router.sh` (needs `cargo build -p octo`; uses ports 8811, 8812, 8815, 8816).

API additions:

- `GET /v1/config` also returns `router` (bool) and `router_capabilities` (string array, empty without a router).
- Project JSON (`GET/POST/PATCH /v1/projects`) gains `budget_usd` (number or null) and `spent_usd` (number or null, last known spend), and `models.tier_policy` (`auto` | `ceiling` | `fixed`, default `auto`). `POST` and `PATCH` accept `budget_usd` (> 0; `null` on PATCH removes it) and `models.tier_policy`; invalid values are 400 `invalid_request`.
- `/v1/usage` with a router: `group=model` buckets are keyed by the served model; `cost_usd` is the router's figure (`cost_estimated` true when the router estimated it).

## Data layout

Under `--data-dir` (default `./data/harness`):

- `harness.sqlite` — legacy CLI sessions and message JSON
- `registry.sqlite` — project index (`serve`)
- `projects/{id}/project.sqlite` — everything for one project: folders, agents, messages, notes
- `cache/` — cached remote tool manifests
- `prices.toml` — optional price table for usage cost estimates (you create it; the harness only reads it)

Harness data is separate from Octo Rust `data/history.sqlite`.

## Local tools and workspace

`read_file`, `write_file`, and `list_dir` resolve paths under `--workspace` only (symlink escape rejected). Under `serve`, they resolve under the project's attached folders (optional `folder` label per call); `bash` runs with the chosen folder as cwd and is equally unsandboxed. `bash` is documented above: full host shell, not a sandbox. Path checks for file tools happen at resolve time, not again at open/read/write (TOCTOU). Tool stdout and file reads are capped at 1 MiB (`\n...truncated` when clipped).
