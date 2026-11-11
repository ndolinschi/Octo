# harness

Go agent harness (`github.com/ndolinschi/Octo/apps/harness`): Anthropic Messages tool loop with local workspace tools, optional remote HTTP tools, a project server (`harness serve`: orchestrator + nested sub-agents over HTTP/SSE), and its own SQLite stores. Talks to any Anthropic-compatible Messages endpoint — typically [Octo](../router/README.md) on loopback.

Product architecture: [docs/architecture.md](./docs/architecture.md).

## Security: `bash` is not sandboxed

The **`bash`** tool runs real shell commands as the user running the harness. It can access any path, network, and secret that user can — workspace path checks apply only to `read_file`, `write_file`, and `list_dir`, not to arbitrary commands. Do not run the harness on secrets you would not give to an interactive shell. The command does not inherit the harness's environment wholesale: only an allow-list of variables is passed (`PATH`, `HOME`, locale, proxy and CA settings, toolchain paths ...), never provider keys or anything named like a key, token or secret; see "Child environment" under Running on subscriptions, and `HARNESS_CHILD_ENV_ALLOW` to add names.

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

Manifest format and more examples (gopls, TypeScript, Gemini CLI, the subscription agents): [`plugins-examples/README.md`](plugins-examples/README.md).

For Claude Code, Copilot, Grok, Codex and seven more agent CLIs on a subscription, see [Running on subscriptions](#running-on-subscriptions).

**Trust:** an ACP agent is a separate program that runs with your user's privileges. The harness **auto-approves** its permission requests and serves its file requests only inside the project's folders; the agent process itself is not sandboxed, and a plugin manifest is a list of commands the harness will run. Only install plugins you trust.

## Running on subscriptions

The supported way to use a Claude, Copilot, Grok, ChatGPT/Codex or similar subscription is to run the vendor's own agent CLI, which the harness drives over ACP as a sub-agent (design: [`docs/superpowers/specs/2026-11-10-subscription-agents-design.md`](../../docs/superpowers/specs/2026-11-10-subscription-agents-design.md)). Nothing is proxied and the harness never reads a vendor's credential files: the CLI finds its own login, and the harness only runs the commands in the manifest.

**Verification status: only the scripted fake agent has been run against this harness.** No vendor CLI has been started from this repository's tooling. The Copilot, Grok and Codex entries were checked against vendor docs; the commands for **cursor, opencode, antigravity, devin, droid, omp and pi** (and the Claude Code adapter's login probe) come from vendor docs, the [ACP registry](https://agentclientprotocol.com) and secondary sources, and are **unverified**: binary names, flags, probe exit codes and auth method ids may be wrong for your version. Treat each entry as a starting point and run `scripts/test-subscriptions.sh <id>` on a machine where you are logged in.

Plugin `subscription-agents` ships these agents (the research report's ten, plus Copilot):

| id | Command | How to log in | Env var (forwarded from the harness) | Auth methods tried | Confidence |
| --- | --- | --- | --- | --- | --- |
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp` | `claude` (Claude login); probe `claude auth status` | none; `ANTHROPIC_API_KEY` is hidden (per-token) | default | ACP registry; probe unverified |
| `copilot` | `copilot --acp --stdio` | CLI login, or token in `COPILOT_GITHUB_TOKEN` | `COPILOT_GITHUB_TOKEN` | default | vendor docs (preview) |
| `grok` | `grok agent [-m M] stdio` | `grok login`; `XAI_API_KEY` is per-token | `XAI_API_KEY` | `xai.api_key` (only if `XAI_API_KEY` set), `cached_token` | registry + secondary |
| `codex` | `npx -y @agentclientprotocol/codex-acp` | `codex login [--device-auth]`; probe `codex login status` | `CODEX_HOME` from `OCTO_CODEX_HOME` | default | registry + vendor docs |
| `cursor` | `cursor-agent acp` (docs also show `agent acp`) | `cursor-agent login` (browser), or `CURSOR_API_KEY`; probe `cursor-agent status` | `CURSOR_API_KEY` | default, `cursor_login` skipped | vendor docs + registry; probe exit code unverified |
| `opencode` | `opencode acp` | `/connect` inside opencode (provider credentials) | none | default | vendor docs + registry |
| `antigravity` | `agy acp` (needs agy 1.5.0+) | interactive `agy` sign-in, or `agy acp --login` in a terminal | none | default | vendor docs; registry ships a different server |
| `devin` | `devin acp [--model M]` | `devin auth login`, or `WINDSURF_API_KEY`; probe `devin auth status` | `WINDSURF_API_KEY` | `windsurf-api-key` (only if set), `cached_token` | vendor docs + registry; probe unverified |
| `droid` | `droid exec --output-format acp [-m M]` | `FACTORY_API_KEY` (headless); browser pairing is never attempted | `FACTORY_API_KEY` (plus two auto-update opt-outs) | `factory-api-key` (only if set); `device-pairing` skipped | registry + secondary; `acp` vs `acp-daemon` unverified |
| `omp` | `omp acp` | interactive `omp` sign-in (credentials in `~/.omp`) | `PI_CODING_AGENT_DIR` from `OCTO_OMP_DIR` | default | secondary only; not in the registry |
| `pi` | `npx -y pi-acp` (needs `pi` on PATH) | `pi` then `/login`, or provider keys in pi's config | none | default (the adapter offers terminal login only) | registry; third-party MVP adapter |

"Default" auth methods means: every advertised method that needs no interaction, in the agent's own order, never one whose id contains `device`, `pairing`, `terminal`, `browser` or `login` unless the manifest lists it.

1. Install and log in to each CLI you want, following the vendor's documentation (commands change between versions, so they are not copied here):
   - GitHub Copilot CLI: [GitHub Copilot docs](https://docs.github.com/en/copilot) (search for the Copilot CLI). Its ACP mode (`copilot --acp --stdio`) is in public preview. Headless login: a fine-grained personal access token with the **Copilot Requests** permission in `COPILOT_GITHUB_TOKEN` (the CLI's documentation describes creating it). Start the harness with that variable set and the manifest forwards it (`"COPILOT_GITHUB_TOKEN": "${COPILOT_GITHUB_TOKEN}"`).
   - Grok CLI (`grok agent stdio`): [xAI docs](https://docs.x.ai). Log in with the CLI. `XAI_API_KEY` is the documented headless path but is billed per token, not on the subscription, and the harness does not copy the CLI's own login file.
   - Codex: [OpenAI docs](https://developers.openai.com/codex). The example runs the adapter `@agentclientprotocol/codex-acp` through `npx`, which needs Node.js; log in with the Codex CLI (`codex login`, or its device-code option on a headless machine).
   - The other agents: see the table above and each manifest's `auth.hint` (shown by `GET /v1/plugins`).
2. Load the example plugin: `go run ./cmd/harness serve --plugins-dir plugins-examples/subscription-agents`. Copy and edit the manifest to change commands, add `models`, or add an `auth.probe`; nothing in `plugins-examples` loads by itself.
3. `GET /v1/plugins` shows each agent with `available` (command found), `logged_in` (`true`/`false`, or `null` when the manifest has no probe or it has not run yet) and the manifest `hint`. In a project, ask the orchestrator to delegate to the agent, optionally naming a model; a CLI that is logged out fails that sub-agent with the hint in its error and the orchestrator carries on.

**Child environment (allow-list).** Every process the harness starts (the `bash` tool, an agent, a language server, a login probe) gets only permitted variables from the harness's own environment; everything else is dropped, so an unlisted provider key (`MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, `HF_TOKEN` ...) never reaches a shell command or a CLI. Always passed: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `COLORTERM`, `TZ`, `TMPDIR`, `TEMP`, `TMP`, `PWD`, `HOSTNAME`, `XDG_*`, `DISPLAY`, `WAYLAND_DISPLAY`, `SSH_AUTH_SOCK` (git over ssh; the one deliberate exception to the secret rule), proxy and TLS settings (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` in either case, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`), toolchain locations and switches (`GOPATH`, `GOROOT`, `GOCACHE`, `GOMODCACHE`, `GOFLAGS`, `GOTOOLCHAIN`, `GOPROXY`, `GONOPROXY`, `GOSUMDB`, `GONOSUMDB`, `GOPRIVATE`, `GOOS`, `GOARCH`, `CGO_ENABLED`, `CC`, `CXX`, `CARGO_HOME`, `RUSTUP_HOME`, `CARGO_TARGET_DIR`, `NVM_DIR`, `NODE_PATH`, `PNPM_HOME`, `npm_config_*`, `JAVA_HOME`, `PYTHONPATH`, `VIRTUAL_ENV`, `CONDA_PREFIX`), `CI`, `NO_COLOR`, `FORCE_COLOR` and `CODEX_HOME`. Never passed, even when a rule above matches: a name containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or `CREDENTIAL` (for `npm_config_*` also `AUTH`), or ending in `_BASE_URL` or `_API_BASE`, and, as a second guard, names starting with `ANTHROPIC_`, `OPENAI_`, `XAI_`, `GROK_CODE_`, `GEMINI_`, `GOOGLE_GENAI_`, `GOOGLE_API_KEY`, `OPENROUTER_` or `HARNESS_`, or the Octo router secrets `OCTO_KEY`, `OCTO_HISTORY_TOKEN_KEY`, `OCTO_CONFIG`. Without this, the harness's `ANTHROPIC_API_KEY` (often `mock` in development), `XAI_API_KEY` or an `OPENAI_*` variable would reach a subscription CLI and could switch it to per-token billing or to a mock endpoint, and any key in the shell that started the harness would be readable by a model-written `env`. **Operator allow-list:** `HARNESS_CHILD_ENV_ALLOW="GITHUB_TOKEN,AWS_*"` (comma separated exact names and `PREFIX_*` patterns, case-insensitive, read once at start-up) passes more variables to every child process, including the `bash` tool; this is the only way to give `bash` a `GITHUB_TOKEN`. It lifts the key/token/secret/`_BASE_URL` rule for the names it lists, but never the second-guard names (`ANTHROPIC_*`, `HARNESS_*`, ...), and a bare `*` is ignored. To pass a key to one agent **on purpose**, declare it in the manifest's `env`: `"env": {"XAI_API_KEY": "${XAI_API_KEY}"}` forwards the harness's value (the `${NAME}` reference is resolved against the harness's real, unfiltered environment, and the entry is dropped when the variable is unset or empty), and a literal value also works. Manifest `env` is applied after the filter, so it always wins. Note the shipped Grok, Devin, Droid, Cursor, Copilot and Gemini entries do forward their own key variable this way; unset it in the harness environment to stay on the subscription. This is also why `requiresEnv` in `auth.methods` looks at the agent's environment, after the filter and the manifest `env`.

**`CODEX_HOME` isolation.** Codex keeps its login and state in `$CODEX_HOME` (default `~/.codex`). The example manifest sets `CODEX_HOME` from `OCTO_CODEX_HOME`, so starting the harness with `OCTO_CODEX_HOME=/path/to/dir` gives the harness its own Codex home; log in once with `CODEX_HOME=/path/to/dir codex login` and the sub-agent and the probe both use that folder. Without `OCTO_CODEX_HOME` the entry is left unset and Codex uses its default.

**What a run costs.** Sub-agent runs are charged to the plan, not to an API key: a Copilot run consumes premium requests (model multipliers apply, see GitHub's billing page), Grok and Codex runs count against the subscription's usage limits, and all three can be rate-limited or refused when a limit is hit (the error shows in the sub-agent). The harness records the agent as `acp:<id>[/<model>]` and shows token and cost figures only when the agent reports them in `usage_update`; plan usage is not readable from here. The orchestrator itself still calls the Messages API configured with `--base-url`, which is billed as before.

**Live tests.** They are off by default, need the real CLIs and use a little quota. One sub-agent per CLI reads a marker file in a temporary project and answers; the test checks for an assistant message, the marker (or a tool call on that file) and a clean completion. A missing CLI (for the npx adapters, the CLI they wrap: `claude`, `pi`) or a logged-out probe skips the test and prints why.

```bash
scripts/test-subscriptions.sh                 # copilot, grok, codex
scripts/test-subscriptions.sh codex           # only Codex
scripts/test-subscriptions.sh cursor droid    # any of the unverified ones
scripts/test-subscriptions.sh all             # every agent in the table
# or directly; the switch is OCTO_TEST_<ID>=1 (upper-case, "-" as "_", e.g. OCTO_TEST_CLAUDE_CODE)
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
| (env only) | `HARNESS_CHILD_ENV_ALLOW` | Extra variable names (`NAME,PREFIX_*`) passed to child processes and the `bash` tool; read once at start-up |

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

## Compaction marker, context breakdown and side question

- **`agent.compacted`.** When a router compaction is applied, the project stream carries `{type: "agent.compacted", seq, agent_id, upto_message_id, summary_tokens, at}` (`summary_tokens` is an estimate, characters / 4). The same markers come with the transcript: `GET /v1/projects/{id}/agents/{aid}/messages` returns `{"messages": [...], "compactions": [{upto_message_id, at, summary_tokens}]}` (oldest first, `[]` when none); the UI draws a "History compacted" separator after the message with that id. The raw messages are all still returned.
- **`GET /v1/projects/{id}/context[?agent=<id>]`** returns `{agent_id, model, window_tokens, used_tokens, estimated, parts: [{key, tokens}]}` for what the orchestrator's (or the named agent's) next request would contain, after compaction. `parts` always holds the six keys `system`, `tools`, `notes`, `messages`, `tool_results`, `summary`, in that order, and sums to `used_tokens`. `used_tokens` is the last response's reported input plus cache read and cache write tokens (`estimated: false`; a figure from before the latest compaction no longer counts); with none, it is the character-count estimate (chars / 4) and `estimated` is `true`. The split into parts is always an estimate: character counts scaled to the total. `window_tokens` is `null` unless known: the harness ships no window table (none of its models has a documented window in this repository); set sizes with `HARNESS_CONTEXT_WINDOWS="model=tokens,model=tokens"` (the served model is tried first, then the requested one; an ACP agent's own reported window is the fallback). Unknown project or agent is 404.
- **Side question.** `POST /v1/projects/{id}/side` with `{"text": "..."}` returns `202 {side_id, message}` (the stored question) and answers on the project stream: `side.delta {side_id, text}` (only while the harness streams), then `side.done {side_id, message}` (the stored answer) or `side.error {side_id, error}` (`"cancelled"` after a clear). One agent loop answers it from the orchestrator's current effective history (summary plus later messages, read-only) with read-only tools only (`list_dir`, `read_file`, `search_files`, `read_notes`), at most 6 rounds of tool calls, on the project's fast model (`models.side` overrides it). It never touches the orchestrator's messages, needs no turn slot and works while a turn runs; usage rows carry role `side` (attributed to the orchestrator, not added to its token totals, counted in `/v1/usage` and the project's spend; `group=agent` shows them as their own `side` bucket). Follow-ups include the earlier side questions and answers. One at a time: a second question while one runs is `409 side_in_progress`. `GET /v1/projects/{id}/side` lists the conversation (`{"messages": [{id, side_id, role: "user"|"assistant", text, created_at}]}`); `DELETE` cancels a running question and clears it (`204`). A failed question leaves no stored trace. With the router integration on, the requests carry role `sub`, depth `1` and tier hint `fast`.

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
