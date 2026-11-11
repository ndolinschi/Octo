# Subscription agents: GitHub Copilot, Grok, Codex — design

**Date:** 2026-11-10 · **Status:** S1 approved to build (owner: "we must support Copilot, Grok and Codex subscriptions for routing and in the harness — important for tests"); S2 and S3 designed, S3's router option needs an owner decision
**Builds on:** [`2026-11-10-workspace-plugins-acp-design.md`](./2026-11-10-workspace-plugins-acp-design.md) (ACP sub-agents), [`2026-11-10-usage-design.md`](./2026-11-10-usage-design.md)
**Research:** a sub-agent's sourced report (vendor docs, the ACP registry, and the adapters of an open-source app that drives these CLIs); not re-verified by the orchestrator. Items marked *unverified* below came from search snippets or secondary sources.

## What the vendors support

| | Copilot | Grok | Codex |
| --- | --- | --- | --- |
| Agent CLI over ACP | Native: `copilot --acp --stdio` (public preview) | Native: `grok agent stdio` | Adapter: `npx -y @agentclientprotocol/codex-acp` (bundles the Codex CLI); also `codex app-server` (JSON-RPC) and `codex exec --json` |
| Headless login on the subscription | Fine-grained PAT with "Copilot Requests" in `COPILOT_GITHUB_TOKEN` (documented) | Browser login; `XAI_API_KEY` is the documented headless path but is per-token billing, not the subscription; copying `~/.grok/auth.json` is not a documented path | `codex login --device-auth`, credentials in `$CODEX_HOME/auth.json`; OpenAI's documented CI default is an API key |
| Model / effort selection | `/model`; effort only as a start-up flag (`--effort`) | `-m`, `/model`; `grok models` lists them | Per turn over app-server; via the ACP adapter's session options |
| Limits readable by a client | Not found | Only an undocumented endpoint | `account/rateLimits/read` over app-server (documented, shape *unverified*) |
| Documented HTTP API paid by the subscription | None (GitHub Models is retired; the Copilot chat endpoint is undocumented) | None (`api.x.ai` is billed separately) | None (`api.openai.com` is billed separately) |

Consequence: **the supported way to use a subscription is to run the vendor's agent CLI**, not to send HTTP requests
on its behalf. The harness already runs ACP agents; the router is an HTTP proxy and has nothing official to proxy to.

## S1 — the three agents as sub-agents (harness; build now)

1. **Manifests.** `apps/harness/plugins-examples/subscription-agents/plugin.json` with agents `copilot`
   (`copilot --acp --stdio`), `grok` (`grok agent stdio --no-auto-update` if the flag applies to that mode), `codex`
   (`npx -y @agentclientprotocol/codex-acp`), each with a label and the env it reads. Replace the unverified
   commands in `plugins-examples/acp-agents`.
2. **Manifest additions** (backward compatible): per agent `models?: string[]` + `defaultModel?: string` +
   `modelArg?: string[]` (argument template, e.g. `["-m", "{model}"]`) for CLIs that take the model at start-up;
   `auth?: { probe: string[]; hint: string }` — a command that exits 0 when the CLI is logged in (never starts a
   session, never logs in) and a one-line hint shown when it is not; `env` values may reference the harness
   process environment as `${NAME}` (resolved at spawn; a missing variable leaves it unset, never an empty string).
3. **ACP client.** Handle what real agents do that the scripted one does not: `authenticate` when `initialize`
   advertises auth methods and the session start is refused (pick the method that needs no interaction; otherwise
   fail the sub-agent with the manifest's hint); session config options / `session/set_model` when the agent
   advertises models (use the requested model, else the manifest default); agents that reject client MCP servers
   (send none — already the case); permission requests keep today's auto-approve until v7's approvals land.
4. **`spawn_agent`** gains optional `model` for ACP agents (enum from the manifest when present). The agent's
   recorded model becomes `acp:<id>/<model>`.
5. **API.** `GET /v1/plugins` agents gain `logged_in: boolean | null` (null = no probe), `models`, `default_model`,
   `hint`. Probes run at most once a minute per agent, with a 5 s timeout, off the request path.
6. **Tests.** Unit tests with the scripted agent extended to advertise auth methods and models. **Live tests** behind
   `-tags subscription` and env switches (`OCTO_TEST_COPILOT=1`, `OCTO_TEST_GROK=1`, `OCTO_TEST_CODEX=1`): for each,
   one sub-agent run that reads a file and answers, asserting the transcript, the confined file read and a clean
   exit; skipped (not failed) when the CLI is missing or the probe says logged out. A documented `make`-style
   command and a README section "Running on subscriptions" (install, login, the PAT permission for Copilot,
   `CODEX_HOME` isolation, cost notes: Copilot premium requests, plan limits).
7. **Acceptance.** With a logged-in CLI, `[acp]`-style delegation to each agent completes through the UI; logged out,
   the Integrations view says so with the hint; the three live tests pass on a machine with the subscriptions
   (to be run by the owner or in an environment with credentials — this repository's CI has none).

## As built — agent hygiene and the ten agents (2026-11-11)

From the Synara research ([`../research/2026-11-11-synara-gap.md`](../research/2026-11-11-synara-gap.md)):

- **Environment scrub** (`internal/childenv`): ACP agents, language servers and auth probes no longer inherit the
  harness's provider keys and base URLs (`ANTHROPIC_`, `OPENAI_`, `XAI_`, `GEMINI_`, `OPENROUTER_`, `HARNESS_`,
  `*_BASE_URL`, router secrets). A manifest passes a key on purpose with `"env": {"XAI_API_KEY": "${XAI_API_KEY}"}`.
  The orchestrator's own `bash` tool still sees the full environment.
- **Auth preference**: `auth.methods` (ids, or `{id, requiresEnv}`), `auth.skip`; interactive methods (device
  pairing, terminal, browser) are never attempted unattended.
- **`{modelArgs}`** inside `args` places the model flag (Grok: before `stdio`).
- **`subscription-agents` 0.2.0** lists eleven agents: claude-code, copilot, grok, codex, cursor, opencode,
  antigravity, devin, droid, omp, pi. **Only the scripted agent has been run**; the seven new entries come from
  vendor docs, the ACP registry or secondary sources. Live tests: `OCTO_TEST_<ID>=1` with `-tags subscription`.
- Where a manifest forwards a vendor API key (Grok, Cursor, Devin, Droid), a key set in the harness environment
  wins over the cached subscription login — unset it to stay on the subscription.

**Revised the same day (external review):** the scrub is now an **allow-list** — children (ACP agents, language
servers, probes **and the `bash` tool**, which used to inherit everything) get only known-harmless variables
(paths, locale, proxy/CA, toolchain locations); any name containing KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL is
dropped. The operator passes more with `HARNESS_CHILD_ENV_ALLOW="NAME,PREFIX_*"`; a manifest's explicit `env` still
passes a key on purpose. Agent JSON gains `served_model` and `routed_tier` (the newest main-thread usage row), carried
by the existing `agent.updated`.

## S2 — the orchestrator on a subscription (design; build after S1 is proven live)

A project's `models.orchestrator` may be `acp:<agent>[/<model>]`. The orchestrator then runs as an ACP session
instead of the built-in loop. Its harness tools (`spawn_agent`, notes, project files) are exposed to it as an
**MCP server run by the harness** and passed in `session/new.mcpServers` (stdio transport spawned by the agent,
bridged to the harness over a per-session token on localhost). The agent's own file and shell tools are confined by
ACP `fs/*` handling and, from v7, by approvals. The session is kept alive across user requests (one ACP session per
project orchestrator, resumed with `session/load` when the agent supports it; otherwise the harness replays a
summary). Tiers may also map to ACP agents (`fast: acp:grok/…`), so a project can run entirely on subscriptions.
Open points: agents that refuse client MCP servers (Copilot CLI 1.0.105 was reported to reject stdio servers —
*unverified*), history replay cost, per-agent quirks. This is the largest gap against comparable tools.

## S3 — routing

"Routing" for subscriptions means choosing **which agent and model** handles a task, not proxying HTTP.

- **S3a (recommended).** The harness asks the router for a decision (`POST /v1/decisions`-style: complexity band for
  a task) and maps bands to the project's tiers, which S2 lets point at subscription agents. The router's ladder and
  classifier are reused; no subscription traffic passes through the router; cost accounting stays in the harness
  (reported by the agent where available).
- **S3b (needs an owner decision; not recommended).** A router backend that calls a vendor's private endpoint with
  the CLI's stored credentials (what community proxies do for Copilot and Codex). No vendor documents this for
  third parties; GitHub has publicly endorsed one specific third-party client, which is not a general permission;
  accounts can be rate-limited or suspended; endpoints change without notice.

## Decisions for the owner

1. S3: a or b. Default: a.
2. Grok on a subscription in automated tests has no documented headless login. Options: test Grok with an API key in
   CI and on the subscription only on a developer machine; or accept copying the CLI's credential file to the test
   runner. Default: the former.
