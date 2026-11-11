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
