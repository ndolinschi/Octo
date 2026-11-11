# Harness documentation

Product docs for the Go agent harness (`apps/harness/`). Operational notes and build commands stay in [`../README.md`](../README.md); monorepo map in [`../../README.md`](../../README.md).

| Doc | Contents |
| --- | --- |
| [architecture.md](./architecture.md) | Modules, project server, data flow, tools, CLI, Octo integration |
| [settings.md](./settings.md) | `GET`/`PUT /v1/settings`: the settings list (ids, kinds, apply mode), `harness.env` writing, router settings for the desktop shell, security rules |
| [providers.md](./providers.md) | `GET /v1/providers` (API, router, ACP agents: state, models, hints, suggested defaults), the `providers.updated` event, `422 model_unavailable` / `409 no_provider`, live API key, failed-turn retry |
| [v7.md](./v7.md) | Changes per turn and diffs (bash snapshots, limits), approvals (built-in and ACP), the message queue, forms and secrets: exact API, events, decisions |
| [memory.md](./memory.md) | Orchestrator memory (M1 and M2): task records, memory files, FTS5 search (Russian inflections), recall, the post-turn digest, API and events |
| [acp-orchestrator.md](./acp-orchestrator.md) | Running a project's orchestrator as an ACP agent: config, sessions, harness tools over MCP, limits; Claude Code, Copilot and Grok setup; failure messages; `harness doctor`, `GET /v1/diagnostics`, the ACP wire trace |

## Security

The **`bash`** local tool runs a real shell with the harness process user. It is **not** sandboxed. See [architecture.md](./architecture.md#local-tools) and the user README before pointing the harness at sensitive workspaces.
