# Architecture

The system overview (the processes and who starts whom, the parts, data locations,
the main flows, the module map, the cross-cutting rules, every environment variable, status, the specs index) is **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)**.

Per part:

- Router (Octo): [`apps/router/docs/architecture.md`](./apps/router/docs/architecture.md); index [`apps/router/docs/README.md`](./apps/router/docs/README.md).
- Harness: [`apps/harness/docs/architecture.md`](./apps/harness/docs/architecture.md); index [`apps/harness/docs/README.md`](./apps/harness/docs/README.md).
- UI: [`packages/ui/ARCHITECTURE.md`](./packages/ui/ARCHITECTURE.md), [`packages/ui/COMPONENTS.md`](./packages/ui/COMPONENTS.md). Client: [`packages/agent-client/AGENTS.md`](./packages/agent-client/AGENTS.md).
- Desktop host and shell: [`apps/desktop/docs/architecture.md`](./apps/desktop/docs/architecture.md).

The runtime view (start-up, failure modes, API by area, data model, limits, diagnostics): **[`docs/SYSTEM.md`](./docs/SYSTEM.md)**. UI components and tokens: [`packages/ui/COMPONENTS.md`](./packages/ui/COMPONENTS.md). Dead weight: [`docs/CLEANUP.md`](./docs/CLEANUP.md).

Monorepo map and commands: [`AGENTS.md`](./AGENTS.md). Current state and next steps: [`docs/superpowers/HANDOVER.md`](./docs/superpowers/HANDOVER.md).
