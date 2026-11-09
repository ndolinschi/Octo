# Octo Desktop

Tauri 2 shell for shared UI (`@octo/ui`). Phase 1: placeholder screen showing harness bridge URL.

Architecture: [docs/architecture.md](./docs/architecture.md).

## Prerequisites

- pnpm 10+ (repo root `pnpm install`)
- Rust **1.90+** for `src-tauri` (see `src-tauri/rust-toolchain.toml`)
- [Tauri OS prerequisites](https://tauri.app/start/prerequisites/) for local `tauri dev` / `tauri build`

## Commands

```bash
# from repo root
pnpm --filter @octo/desktop build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @octo/desktop tauri dev
```

Optional: `VITE_HARNESS_BRIDGE_URL` (default via `@octo/agent-client`: `http://127.0.0.1:8790`).
