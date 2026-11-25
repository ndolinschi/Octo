## What does this change?

<!-- A short description of the change and why it is needed. Link the issue it fixes, e.g. "Fixes #123". -->

## How was it tested?

<!-- Commands you ran and what you checked by hand. -->

- [ ] `pnpm lint` and `pnpm test` (if TypeScript changed)
- [ ] `go test ./...` in `apps/harness` (if the harness changed)
- [ ] `cargo test -p octo` and `cargo clippy -p octo --all-targets -- -D warnings` (if the router changed)

## Screenshots

<!-- For UI changes: before / after. Delete this section otherwise. -->

## Checklist

- [ ] The change is focused; unrelated fixes are in separate pull requests.
- [ ] Docs are updated where behaviour or setup changed.
- [ ] No secrets, `.env` files, local data or build output are committed.
