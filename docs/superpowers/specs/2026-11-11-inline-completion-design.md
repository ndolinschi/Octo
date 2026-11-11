# Inline completion in the editor — design

**Date:** 2026-11-11 · **Status:** approved to build (owner: "add a setting for an inline-completion model for the
Monaco editor, so it works like in Cursor")

## What the user gets

Grey "ghost" text at the cursor while typing in the Files tab. `Tab` accepts all of it, `Cmd/Ctrl+→` accepts the
next word, `Esc` dismisses, typing on refines it. A setting chooses the model; with no model chosen the feature is
off and costs nothing.

## Decisions

1. **A separate, fast model.** Project setting `models.completion` (provider model id, or a router tier). Not an ACP
   agent: a CLI session answers in seconds, a completion must answer in a few hundred milliseconds. Without an API
   key or a router the setting is disabled and the Settings row says why.
2. **One harness endpoint.** `POST /v1/projects/{id}/complete` with `{path, language, prefix, suffix, max_lines?}`
   (prefix ≤ 6 000 chars before the cursor, suffix ≤ 2 000 after; the client cuts on line boundaries) →
   `{text, model, ms}` or `204` when there is nothing to suggest. The request is cancelled when the client aborts.
   Single response, no streaming in the first version.
3. **Prompt.** Fill-in-the-middle through the messages API: the file path, language, prefix and suffix in tagged
   blocks; the model returns only the insertion. `max_tokens` 160, temperature 0, stop at a blank line after the
   first statement unless the cursor is at an empty block. The harness strips fences and any echoed prefix/suffix
   and drops a result that only repeats the next line. Through the Octo router the request carries the lowest tier
   hint and is marked `completion`, so it is never classified.
4. **Context beyond the file** (second step, same endpoint): up to three snippets from other open tabs and the last
   edits of this session, chosen by the client; LSP symbols are not used yet.
5. **Client behaviour.** Monaco `registerInlineCompletionsProvider`; request after 120 ms without a keystroke; the
   previous request is aborted; a small LRU (50 entries keyed by path + prefix tail + suffix head) answers repeats
   and "typed the first characters of the suggestion" without a request; nothing is requested inside a selection,
   in a read-only file, while an IME composition is open, or when the LSP completion list is showing.
6. **Privacy and limits.** Never sent: files that match the project's ignore rules for secrets (`.env*`, `*.pem`,
   `*.key`, `id_*`, anything under `.git/`), files over 1 MB, binary files. Values from the secret store are
   redacted from prefix and suffix. Usage is recorded with role `completion` and counts toward the project budget;
   when the budget is reached completion stops quietly and the status item says so.
7. **Settings and status.** Settings → Editor: on/off, model, per-language off list. The editor's status line shows
   a small state item: off / ready / thinking (a 1 px shimmer, no spinner) / paused (budget or error, with the
   reason on hover). No toast on failure.

## Acceptance

- Harness: unit tests for trimming, fence/echo stripping, the never-sent list, redaction, cancellation (the upstream
  request is aborted), usage role and budget stop; an e2e case against the mock model.
- UI: provider tests (debounce, abort, cache hit while typing into a suggestion, the "do not request" cases), the
  three keys, the Settings row in the keyless state; screenshots of ghost text in dark and light.
- Measured on the mock: time from keystroke to ghost text ≤ 120 ms debounce + response; **latency with a real model
  is not measurable here** — the owner's first session is the test; the `ms` field and the usage view show it.

## Open

- A real FIM endpoint (models that expose one are faster and cheaper than prompting a chat model).
- Next-edit prediction (jump-and-edit suggestions) — a different feature; not in this design.

## As built (harness)

Harness side only; the editor provider, the setting row and the status item are the UI's. API and rules: `apps/harness/README.md` ("Inline completion").

- **Setting.** `models.completion`: a Messages API model id or a tier name, resolved like the other tiers (`config.Models.CompletionModel`); absent is off; `"off"` in a PATCH clears it (a project's own value is never inherited as "off"); an ACP agent (`acp:...`), an id over 200 characters or with whitespace is a `400`. No global default and no environment variable for it.
- **Endpoint.** `POST /v1/projects/{id}/complete` (`internal/bridge/complete.go`, `Orchestrator.Complete`): `200 {text, model, ms}`, `204` (nothing to suggest; the never-sent list, with `X-Completion-Skipped`), `400`, `404`, `409 completion_off` (no model chosen, or the no-key message when the built-in loop cannot run), `409 budget_reached` (checked before any request), `502 completion_failed`. Request fields beyond the design: `folder` (so the file's real size can be checked) and `snippets` (up to three, from other open files; snippets of never-sent files are dropped).
- **Prompt and post-processing** (`internal/completion`): tagged `<snippet>`, `<file>`, `<prefix>`, `<cursor/>`, `<suffix>` blocks; `max_tokens` 160; temperature 0 (the SDK has no typed field: `option.WithJSONSet`; `agent.Loop` gained `Temperature` and `StopSequences`); stop sequence `"\n\n"` unless the cursor is in an empty block (`StartsBlock`); `Clean` strips fences, an echoed prefix or suffix, a result that only repeats the next line, and cuts to `max_lines`.
- **Privacy.** Never sent: `.env*`, `*.pem`, `*.key`, `id_*`, anything under `.git/`, files over 1 MB, text with NUL bytes. Stored secret values are redacted from path, prefix, suffix and snippets; a suggestion that contains the mask is dropped.
- **Cancellation.** The request context is the model call's: a client abort aborts the upstream request (test with an upstream that never answers).
- **Usage and budget.** Rows have role `completion`, attributed to the orchestrator and not in its totals; they count in `/v1/usage` and in spend. With the router: tier hint `fast`, policy `fixed`, task `completion`, never classified. At the budget the call is refused before a request is made.
- **Tests.** `internal/completion` (validation, never-sent, 15 cleaning cases, prompt, stop sequences); `orchestrator/completion_test.go` (off, usage role, stop sequences, never-sent and snippets, redaction, cancellation, tier resolution, `off` clearing, ACP refused, budget stop with router hints, upstream failure); `bridge/complete_test.go` and the no-key case in `nokey_test.go`; the e2e case in `scripts/e2e-v7.sh` (off, a suggestion with the mock model, `.env` skipped, usage bucket, off again). Agent-client: `complete?(projectId, input, {signal})` (null for 204) and its types, not on the message bridge (an abort signal cannot cross a port).

Not verified: latency with a real model (the `ms` field and the usage view will show it); that a real model follows the fill-in-the-middle prompt well (prompt quality was not measured); the UI side (provider, keys, status item) is not part of this commit.
