# Octo — agent instructions

Instructions for AI coding agents working in this repository.

## Project

**Octo** is a Rust application crate (`octo`), edition **2021**, built with **Cargo**. Source lives under `src/`. The repo root is the crate root (there is a single `Cargo.toml`).

## Environment setup

After clone, initialize vendored Superpowers:

```bash
git submodule update --init --recursive
```

Rust toolchain: install via [rustup](https://rustup.rs/). Verify with `cargo --version`.

### Editor

Use **rust-analyzer** in Cursor/VS Code. Open the repository root (folder containing `Cargo.toml`).

Recommended extensions (see `.vscode/extensions.json`):

- `rust-lang.rust-analyzer`

## Superpowers

This repo includes Superpowers skills as a git submodule:

`.cursor/skills/superpowers/`

1. **Cursor (local IDE):** install the plugin for hooks and automatic skill bootstrap:

   ```text
   /add-plugin superpowers
   ```

2. **All agents:** project rule `.cursor/rules/superpowers-bootstrap.mdc` applies every session. Read skills with the `Read` tool:

   `.cursor/skills/superpowers/skills/{skill-name}/SKILL.md`

   Invoke `using-superpowers` at the start of work, then use process skills when relevant (`brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, etc.).

User messages and this file take precedence over skills.

## Rust rules

Production-oriented Cursor rules from [tyrchen/cursor-rust-rules](https://github.com/tyrchen/cursor-rust-rules) are vendored under:

`.cursor/rules/rust/`

- **Router:** `main.mdc` (applies when editing `*.rs` / `Cargo.toml`)
- **This crate:** `octo-rust.mdc` — simple binary defaults

Do not fight the borrow checker; match existing style; keep diffs minimal unless the task requires more.

## Commands

| Task | Command |
| --- | --- |
| Build | `cargo build` |
| Run | `cargo run` |
| Test | `cargo test` |
| Format | `cargo fmt` |
| Lint | `cargo clippy -- -D warnings` |

## Git

- Feature branches: `cursor/<short-description>-a705`
- Push with `git push -u origin <branch>`
- Open pull requests against `main`

## What not to do

- Do not commit `target/`
- Do not add large dependencies without a clear requirement
- Do not skip verification when a Superpowers skill requires it (tests, repro steps, etc.)
