# Harness documentation

Product docs for the Go agent harness (`apps/harness/`). Operational notes and build commands stay in [`../README.md`](../README.md); monorepo map in [`../../README.md`](../../README.md).

| Doc | Contents |
| --- | --- |
| [architecture.md](./architecture.md) | Modules, project server, data flow, tools, CLI, Octo integration |
| [settings.md](./settings.md) | `GET`/`PUT /v1/settings`: the settings list (ids, kinds, apply mode), `harness.env` writing, router settings for the desktop shell, security rules |
| [v7.md](./v7.md) | Changes per turn and diffs (bash snapshots, limits), approvals (built-in and ACP), the message queue, forms and secrets: exact API, events, decisions |
| [acp-orchestrator.md](./acp-orchestrator.md) | Running a project's orchestrator as an ACP agent: config, sessions, harness tools over MCP, limits |

## Security

The **`bash`** local tool runs a real shell with the harness process user. It is **not** sandboxed. See [architecture.md](./architecture.md#local-tools) and the user README before pointing the harness at sensitive workspaces.
