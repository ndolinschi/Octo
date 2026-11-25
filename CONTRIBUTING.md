# Contributing to Octo

Thanks for your interest! Octo is early and very raw, so bug reports, design feedback and small focused pull requests are
all valuable.

By participating you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Security problems go through the
[security policy](./SECURITY.md), not public issues.

> **License:** Octo is released under the [MIT License](./LICENSE). By submitting a pull request you agree that your
> contribution is licensed under the same terms.

## Ways to help

- **Report bugs** with the bug template: what you did, what you expected, what happened, your OS and how you ran Octo.
  Screenshots help a lot for UI problems. Remove API keys, tokens and private paths from logs before you paste them.
- **Suggest features** with the feature template. Explain the problem first, then the solution you have in mind.
- **Send pull requests.** For anything bigger than a small fix, please open an issue first so we can agree on the approach.

## Development setup

You need Node.js 22+, pnpm 10+ (`corepack enable`), Go 1.26+ and the Rust toolchain from `rust-toolchain.toml`
(plus Xcode command-line tools on macOS or the WebKitGTK development packages on Linux for the desktop shell).

```bash
pnpm install
pnpm dev:all -- --mock   # harness + mock model + UI in the browser, no API key needed
```

See the [README](./README.md#build-from-source) for the other modes and [AGENTS.md](./AGENTS.md) for the monorepo map and
conventions per part (Go harness, Rust router, TypeScript UI).

## Before you open a pull request

Run the checks for the parts you touched:

```bash
# TypeScript (packages/ui, packages/agent-client, apps/desktop, apps/web)
pnpm lint
pnpm test
pnpm format:check

# Go harness
cd apps/harness && go vet ./... && go test ./...

# Rust router
cargo fmt --check
cargo clippy -p octo --all-targets -- -D warnings
cargo test -p octo
```

CI runs the same checks (`.github/workflows/`).

## Pull request guidelines

- Keep each pull request focused on one change; split unrelated fixes.
- Add or update tests for behaviour changes. Tests live next to the code they cover (`*_test.go`, `*.test.ts`, `apps/router/tests/`).
- Update the docs (`docs/`, `apps/*/docs/`, the user guide) when behaviour or setup changes.
- For UI changes, include before/after screenshots (dark and light theme if relevant).
- Do not commit secrets, `.env` files, local data directories or build output; `.gitignore` covers the usual ones.
- Write clear commit messages in the imperative mood ("Fix approval card wrapping", not "fixed stuff").

## AI-assisted contributions

Much of Octo was written with coding agents, and you are welcome to use them too. You are responsible for what you submit:
read and understand the diff, run the checks above, and make sure the change does what the description says.
