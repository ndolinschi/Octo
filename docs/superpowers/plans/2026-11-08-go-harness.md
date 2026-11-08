# Go Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a thin Go agent harness in `harness/` that runs an Anthropic Messages tool loop against a configurable base URL (Octo / autoroute / Anthropic) with local tools, remote HTTP tools, and its own SQLite store.

**Architecture:** Separate Go module under `harness/` with `cmd/harness` wiring `internal/` packages (config, store, cache, anthropicclient, tools, tools/local, tools/remote, agent). No shared state with the Rust Octo crate. Official `anthropic-sdk-go/v2` for Messages.

**Tech Stack:** Go 1.25+, `github.com/anthropics/anthropic-sdk-go/v2`, pure-Go SQLite (`modernc.org/sqlite`), stdlib `log/slog`, TOML via `github.com/pelletier/go-toml/v2`.

**Spec:** [docs/superpowers/specs/2026-11-08-go-harness-design.md](../specs/2026-11-08-go-harness-design.md)

## Global Constraints

- Module path: `github.com/ndolinschi/Octo/harness`
- Go **1.25+**; Anthropic SDK **v2** only
- Anthropic Messages conventions only (no OpenAI chat loop)
- Harness must not read Octo `config/*.toml` or open `data/history.sqlite`
- Packages: `local` ↛ `remote`/`store`; `remote` ↛ `local`; `store`/`cache`/`config` ↛ `agent`/SDK
- Local tools: `bash`, `read_file`, `write_file`, `list_dir` with workspace path confinement
- Remote: `GET {base}/tools`, `POST {base}/tools/{name}`; name collision → local wins + warn
- Data dir: `HARNESS_DATA_DIR` or `./data/harness/`; SQLite `{data_dir}/harness.sqlite`; cache `{data_dir}/cache/`
- CLI: `harness run --prompt ... [--workspace DIR] [--base-url URL] [--model MODEL]`
- Env: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `HARNESS_DATA_DIR`
- Do not modify Rust `src/` behavior for this plan
- TDD for non-trivial logic; `go test ./...` from `harness/` before each commit
- Branch: `cursor/<short>-ca4d` from current base; commits per task

## Review Focus

- Path escape (`../`) outside workspace must be rejected by local file tools
- Remote tool HTTP non-2xx must become `tool_result` with `is_error=true`
- Agent loop must stop when the model returns no `tool_use` blocks
- Config/base URL must not silently fall back to Octo history paths
- Name collision: local tool shadows remote with a logged warning

## File map

| Path | Role |
| --- | --- |
| `harness/go.mod` | Module root |
| `harness/cmd/harness/main.go` | CLI |
| `harness/internal/config/config.go` | Load env + optional TOML |
| `harness/internal/store/store.go` | SQLite sessions/messages |
| `harness/internal/cache/cache.go` | Disk cache for remote schemas |
| `harness/internal/anthropicclient/client.go` | SDK wrapper |
| `harness/internal/tools/tools.go` | Tool interface + registry |
| `harness/internal/tools/local/*.go` | Direct tools |
| `harness/internal/tools/remote/*.go` | HTTP remote tools |
| `harness/internal/agent/agent.go` | Messages tool loop |
| `harness/examples/remotetool/main.go` | Echo remote for tests |
| `harness/README.md` | Build/run |
| `.github/workflows/harness.yml` | `go test` CI |

---

### Task 1: Module scaffold + config

**Files:**
- Create: `harness/go.mod`
- Create: `harness/internal/config/config.go`
- Create: `harness/internal/config/config_test.go`
- Create: `harness/README.md` (stub: module path + `go test ./...`)

**Interfaces:**
- Produces: `config.Config` with fields `APIKey`, `BaseURL`, `Model`, `DataDir`, `Workspace`, `RemoteBases []string`, `MaxTurns int`; `func Load() (Config, error)` reading env; defaults: `DataDir` = `./data/harness`, `MaxTurns` = `25`, empty `BaseURL` means SDK default

- [ ] **Step 1: Write failing test** `TestLoad_DataDirFromEnv` — set `HARNESS_DATA_DIR` to a temp path, call `Load()`, assert `DataDir` equals that path; `TestLoad_DefaultDataDir` with env unset asserts `./data/harness`

- [ ] **Step 2: Run** `cd harness && go test ./internal/config/ -count=1` — expect FAIL (no package)

- [ ] **Step 3: Implement** `go.mod` (`module github.com/ndolinschi/Octo/harness`, `go 1.25`) + `Load()` as specified; stub README

- [ ] **Step 4: Run** same test — PASS

- [ ] **Step 5: Commit** `feat(harness): add go module and config loader`

---

### Task 2: SQLite store

**Files:**
- Create: `harness/internal/store/store.go`
- Create: `harness/internal/store/store_test.go`

**Interfaces:**
- Consumes: data dir path string
- Produces: `type Store struct`; `func Open(dataDir string) (*Store, error)` creating `{dataDir}/harness.sqlite`; `func (s *Store) CreateSession(ctx, model string) (sessionID string, err error)`; `func (s *Store) AppendMessage(ctx, sessionID, role string, contentJSON []byte) error`; `func (s *Store) Close() error`; driver `modernc.org/sqlite`

- [ ] **Step 1: Write failing test** `TestOpenCreateSessionAppend` — Open temp dir, CreateSession, AppendMessage user+assistant, reopen and verify row count via exported `MessageCount(ctx, sessionID) (int, error)` helper for tests/API

- [ ] **Step 2: Run** `go test ./internal/store/ -count=1` — FAIL

- [ ] **Step 3: Implement** schema `sessions(id TEXT PK, model TEXT, created_at TEXT)` and `messages(id INTEGER PK AUTOINCREMENT, session_id TEXT, role TEXT, content_json TEXT, created_at TEXT)`; migrations on Open

- [ ] **Step 4: Run** — PASS

- [ ] **Step 5: Commit** `feat(harness): add sqlite session store`

---

### Task 3: Tool registry + local tools

**Files:**
- Create: `harness/internal/tools/tools.go`
- Create: `harness/internal/tools/tools_test.go`
- Create: `harness/internal/tools/local/local.go`
- Create: `harness/internal/tools/local/local_test.go`

**Interfaces:**
- Produces: `type Handler func(ctx context.Context, input json.RawMessage) (output string, isError bool, err error)`; `type Def struct{ Name, Description string; InputSchema json.RawMessage; Handle Handler }`; `type Registry struct`; `func NewRegistry() *Registry`; `func (r *Registry) Register(Def) error` (duplicate name → error); `func (r *Registry) Get(name string) (Def, bool)`; `func (r *Registry) AnthropicTools() []` SDK tool params — builder maps to `[]anthropic.ToolUnionParam`
- Local: `func Register(reg *tools.Registry, workspace string) error` registering `bash`, `read_file`, `write_file`, `list_dir`

- [ ] **Step 1: Write failing tests**
  - `TestRegisterDuplicate`
  - `TestReadFile_RejectsEscape` — workspace temp; `read_file` with `{"path":"../outside"}` → `isError true`
  - `TestWriteReadRoundTrip` — write then read same relative path
  - `TestBashEcho` — `{"command":"echo hi"}` contains `hi`

- [ ] **Step 2: Run** `go test ./internal/tools/... -count=1` — FAIL

- [ ] **Step 3: Implement** registry + local tools with path join + `filepath.Abs` confinement check; bash via `exec.CommandContext` with timeout 30s, `Dir=workspace`

- [ ] **Step 4: Run** — PASS

- [ ] **Step 5: Commit** `feat(harness): add tool registry and local tools`

---

### Task 4: Remote tools + cache + example server

**Files:**
- Create: `harness/internal/cache/cache.go`
- Create: `harness/internal/tools/remote/remote.go`
- Create: `harness/internal/tools/remote/remote_test.go`
- Create: `harness/examples/remotetool/main.go`

**Interfaces:**
- Consumes: `*tools.Registry`, remote base URLs
- Produces: `func Register(ctx, reg *tools.Registry, bases []string, cacheDir string) error` — GET each `{base}/tools`, skip names already in registry (slog warn), register handlers that POST `{base}/tools/{name}`; `cache` stores raw schema JSON by URL key with file under `cacheDir`
- Example: listens `:0` or flag addr; `GET /tools` returns one tool `echo` with schema `{type:object,properties:{text:{type:string}},required:[text]}`; `POST /tools/echo` returns body `{"text":...}` echoed as string

- [ ] **Step 1: Write failing test** `TestRemoteRegisterAndInvoke` — start httptest serving discover+invoke; Register into empty registry; call handler; assert output; second case: pre-register local same name, Register remote, assert Get still local

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement** remote + cache + example `remotetool`

- [ ] **Step 4: Run** — PASS

- [ ] **Step 5: Commit** `feat(harness): add remote tools, cache, example server`

---

### Task 5: Anthropic client + agent loop

**Files:**
- Create: `harness/internal/anthropicclient/client.go`
- Create: `harness/internal/agent/agent.go`
- Create: `harness/internal/agent/agent_test.go`

**Interfaces:**
- Produces: `func New(apiKey, baseURL string) anthropic.Client` using `option.WithAPIKey` and `option.WithBaseURL` when baseURL non-empty
- `type Runner struct{ Client anthropic.Client; Registry *tools.Registry; Store *store.Store; Model string; MaxTurns int }`
- `func (r *Runner) Run(ctx context.Context, prompt string) (sessionID string, finalText string, err error)` — create session, append user message, loop Messages.New with tools from registry, on tool_use dispatch registry, append tool_result user message, stop when no tool_use or MaxTurns; persist each message via store; non-streaming OK

- [ ] **Step 1: Write failing test** `TestRunner_ToolRoundTrip` — httptest fake Anthropic: first response one `tool_use` name `echo` input `{"text":"ping"}`; second response text `done`; registry with echo handler; Run; assert finalText contains `done` and MessageCount ≥ 3

- [ ] **Step 2: Run** — FAIL

- [ ] **Step 3: Implement** client + agent loop (parse content blocks; build tool results)

- [ ] **Step 4: Run** — PASS

- [ ] **Step 5: Commit** `feat(harness): add anthropic client and agent loop`

---

### Task 6: CLI + CI + README

**Files:**
- Create: `harness/cmd/harness/main.go`
- Create: `.github/workflows/harness.yml`
- Modify: `harness/README.md`
- Modify: `.gitignore` — add `harness/data/` if needed; ignore harness local sqlite under data

**Interfaces:**
- Consumes: all prior packages
- Produces: `harness run` flags `--prompt` (required), `--workspace` (default `.`), `--base-url`, `--model` (default `claude-sonnet-4-5`), `--data-dir`, `--remote` (repeatable); wire local Register + remote Register + Runner.Run; print final text to stdout

- [ ] **Step 1: Write failing test** optional smoke: `TestMain_Help` or build-only — prefer `go build -o /tmp/harness ./cmd/harness` in verification; add `internal/app` only if main would be untestable — keep logic in packages already tested; main is thin

- [ ] **Step 2: Implement** main + workflow:

```yaml
name: harness
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: harness
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.26.x"
      - run: go test ./...
```

- [ ] **Step 3: Update README** with build/run against Octo autoroute example

- [ ] **Step 4: Run** `cd harness && go test ./... && go build -o /tmp/octo-harness ./cmd/harness`

- [ ] **Step 5: Commit** `feat(harness): add CLI, CI, and README`

- [ ] **Step 6: Mark design status approved/implemented** in spec header if still draft

---

## Self-review notes

- Spec coverage: loop, local/remote tools, isolation, own DB/cache, CLI, upstream modes, example remote, CI — all tasked
- Rust untouched
- Review Focus items pinned in Tasks 3–5 tests
