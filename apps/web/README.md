# Octo Web (future)

Placeholder for the **web shell** that reuses [`@octo/ui`](../desktop/package.json) from `packages/ui`.

## Planned behavior

- Same React screens as [`packages/ui`](../../packages/ui), hosted as static assets.
- `VITE_HARNESS_BRIDGE_URL` points at **harness serve** on Claude / remote infrastructure.
- Tools run **only** on that environment (remote HTTP tool servers); no local `bash` in the browser.

## Status

Not scaffolded yet. See:

- Design: [`docs/superpowers/specs/2026-11-09-desktop-ui-design.md`](../../docs/superpowers/specs/2026-11-09-desktop-ui-design.md)
- Phase 2 bridge: [`docs/superpowers/plans/2026-11-09-harness-bridge-phase2.md`](../../docs/superpowers/plans/2026-11-09-harness-bridge-phase2.md)
