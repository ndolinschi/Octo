# Harness documentation

Product docs for the Go agent harness (`harness/`). Operational notes and build commands stay in [`../README.md`](../README.md); monorepo map in [`../../README.md`](../../README.md).

| Doc | Contents |
| --- | --- |
| [architecture.md](./architecture.md) | Modules, data flow, tools, CLI, Octo integration |

## Security

The **`bash`** local tool runs a real shell with the harness process user. It is **not** sandboxed. See [architecture.md](./architecture.md#local-tools) and the user README before pointing the harness at sensitive workspaces.
