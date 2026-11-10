# subscription-agents

GitHub Copilot (`copilot --acp --stdio`), Grok (`grok agent stdio`) and Codex (`npx -y @agentclientprotocol/codex-acp`) as ACP sub-agents. Each runs on the subscription its own CLI is logged in to; the harness never reads the CLIs' credential files.

```bash
go run ./cmd/harness serve --plugins-dir plugins-examples/subscription-agents
curl localhost:8790/v1/plugins    # available, logged_in (null without a probe), models, hint
```

| Agent | Needs | Login | Env the manifest forwards |
| --- | --- | --- | --- |
| `copilot` | Copilot CLI on `PATH` | CLI login, or a fine-grained token with "Copilot Requests" | `COPILOT_GITHUB_TOKEN` |
| `grok` | Grok CLI on `PATH` | CLI login | none |
| `codex` | `npx` (Node.js); `codex` on `PATH` for the probe | `codex login` | `CODEX_HOME` from `OCTO_CODEX_HOME` |

The commands come from the vendors' documentation and the ACP registry and could not be run in this repository's CI. None of the manifests lists `models`; each agent advertises its own over ACP. The `codex login status` probe is the only one; check it against your Codex version. Full steps, costs and the live tests: harness `README.md`, "Running on subscriptions".
