# Dead weight: what could go, with evidence

A report, not a change: nothing listed here was deleted, moved or edited. The owner decides. Made on 2026-11-22 at commit
`d00bae4` (branch `claude/clever-pascal-s2lr5b`) with the tools named under each finding, run ad hoc (nothing was added to
`package.json`, `go.mod` or `Cargo.toml`).

Each item has one of three marks:

- **Safe to delete**: nothing references it, and the evidence says the tests do not need it. "Tests pass without it" was
  **not run** for any item (no item was removed); the evidence is the reference search.
- **Probably dead**: unused as far as the tools see, but the owner should look (a public surface, a documented command,
  a planned feature).
- **Keep**: looks unused, but is not, or is kept on purpose; the reason is given.

Contents: [Summary](#top-findings) · [TypeScript](#typescript) · [Go](#go) · [Rust](#rust) · [Repository](#repository) ·
[Contradictions](#contradictions-between-documents) · [Plan](#plan)

## Top findings

| # | Item | Mark | Evidence (one line) |
| --- | --- | --- | --- |
| 1 | `packages/ui/src/components/chat/StarterPrompts.tsx` (77 lines) | Safe to delete | No importer in the import graph; `knip` "Unused files"; `grep -rn StarterPrompts` finds only its own definition |
| 2 | `packages/ui/src/components/files/editor/completion/CompletionStatus.tsx` (40 lines) | Safe to delete | Same three checks; last touched in `72b4a92` ("work in progress") |
| 3 | 21 Go functions unreachable even from tests (213 lines with their comments) | Safe to delete | `deadcode -test ./...`; list below; mostly wrappers left when the `...InWorkspace` / `...In` variants replaced them |
| 4 | Unused CSS: `.octo-card`, `.octo-card-dense`, `.octo-heat-0` to `-4` in `packages/ui/src/styles.css` (lines 1200-1266, about 65 lines) | Probably dead | No source mentions the class names, not even as a template prefix (`grep -rn "octo-card\|octo-heat"` over `src` outside the CSS: nothing) |
| 5 | Unused UI functions: `useOpenSessionTab` (38 lines), `useAsync` (10), `CardFrame` (7), `StateWord` (3) | Safe to delete | `knip` "Unused exports" plus a grep: each name appears once, at its definition |
| 6 | `packages/ui/src/components/review/useWidth.ts` = `components/v7/useWidth.ts` (15 lines each) | Safe to merge | `diff` prints nothing: byte-identical |
| 7 | `formatBytes` in four places (`lib/messageSize.ts`, `lib/review/files.ts`, `lib/memory/files.ts`, `demo/v7.ts`), `splitPath` twice (`lib/v7/changes.ts`, `lib/review/files.ts`), `plural` twice, `fileName` twice | Probably dead (duplicates) | Same names exported from several files; the `formatBytes` bodies differ in output (binary units, "B" below 1 KB or not), so merging changes text |
| 8 | Legacy one-shot CLI: `harness run / sessions / show` (`cmd/harness/legacy.go` 169, `internal/store` 149, `internal/agent/runner.go` 90, their tests) | Probably dead | No script, workflow or UI calls it (`grep -rn "harness run"` over `scripts`, `apps/harness/scripts`, `.github`: nothing); still documented in `apps/harness/README.md` |
| 9 | `@tauri-apps/plugin-opener` in `apps/desktop/package.json` | Probably dead | `knip` "Unused dependencies"; no TypeScript imports it; the Rust side uses the crate `tauri-plugin-opener` (`src-tauri/src/lib.rs:118`) |
| 10 | `packages/ui/src/components/chat/readyLazy.ts` (2-line re-export) | Safe to delete after one import edit | Its comment says "Moved to `lib/readyLazy`"; one importer (`Transcript.tsx`) |
| 11 | Deprecated aliases still in use: `Input`/`Textarea` (7 files), `IconButton` from `Button.tsx` (7 files), `SkeletonRows` (2), `INFO_ROW_BUTTON` (1), `Kbd`/`Key` | Keep until migrated | `@deprecated` tags; importer counts from the import graph; `pnpm lint` reports 31 `@typescript-eslint/no-deprecated` warnings |
| 12 | `apps/router/scripts/calibrate.py` (6 KB) | Probably dead | No document, script or workflow names it (reference search over all tracked text files) |
| 13 | Router docs nothing links to: `docs/debug/2026-11-06-taskq-long-session.md`, `docs/superpowers/plans/2026-11-03-openai-chat-proxy.md` | Archive | Reference search: no tracked file names them |
| 14 | Tables `session_declarations`, `file_claims`, `session_messages` (schema 15) | Keep | Only `DELETE` statements touch them (`projectstore/project_sessions.go:925`); they wait for phase 4 of the parallel-sessions spec, and removing them needs a migration |
| 15 | Router history tables `calls`, `decisions`, `session_outcomes` grow without bound | Keep (watch) | The only `DELETE`s are for `autoroute_calls` and `budget_spend` (`apps/router/src/history/records.rs`); not junk, but disk use over months is not bounded |

## TypeScript

**Tools run.** An import graph of `packages/ui/src`, `packages/agent-client/src`, `apps/desktop/src`, `apps/web/src`
(a script that resolves relative imports, `@octo/*` aliases, re-exports and `import()`); `npx -y knip@5.64.1 --reporter
compact` from the repository root (no config file; its output: 40 unused files, 2 unused dependencies, 1 unlisted, 97
unused exports, 146 unused exported types, 3 duplicate exports); `grep` for each candidate.

**Unused files.** The graph finds five production files with no production importer: `apps/desktop/src/main.tsx` and
`apps/web/src/main.tsx` (Vite entries, keep), `StarterPrompts.tsx` and `CompletionStatus.tsx` (safe to delete, findings 1
and 2), `lib/must.ts` (imported only by four tests: keep, it is a test helper). knip's other "unused files" are the
Playwright scripts, `theme.js` in `public/` (loaded by `index.html`), `apps/harness/internal/browserproxy/inspector.js`
(embedded by Go) and files of the vendored skills submodule: all keep.

**Unused exports.** knip's 97 are mostly constants exported for tests (`*_MAX`, `*_MS`, ...) and components loaded with
`import()` whose name knip cannot follow (`RoutingLine`, `SessionTree`, `ProjectList`, `EditorComments`, `LspManager`,
`withDemoExtras`): keep. A grep over the rest found four functions used nowhere, not even in their own file (finding 5):
`components/shell/openSessions.ts` `useOpenSessionTab`, `state/activity.tsx` `useAsync`, `components/v7/parts.tsx`
`CardFrame`, `components/sessions/parts.tsx` `StateWord`. Exported but used only inside their own file (the `export` can go,
the code stays): `assignRef`, `startDownload`, `fetchProviders`, `Breadcrumb`, `QrImage`, `settingsSectionFor`,
`subjectLine`, `dayLabel`, `indexOfGroup`, `callArgs`, `languageName`, `scripts/eslint/no-native-controls.mjs`
`NATIVE_CONTROLS`, `INSTEAD`.

**Dependencies.** knip: `@tauri-apps/plugin-opener` (finding 9); `tailwindcss` in `apps/desktop` and `apps/web` is a false
positive (`@import "tailwindcss"` in both `src/styles.css`); unlisted `estree` in `scripts/eslint/layer-imports.mjs` is a
type-only JSDoc reference (keep).

**Duplicated helpers** (finding 7, plus): `useWidth` twice, byte-identical (finding 6); `errorMessage` in
`packages/ui/src/lib/format.ts` and `apps/desktop/src/errorMessage.ts` (the desktop host may not import `lib`; keep);
`useNow` in `lib/hooks.ts` and `components/settings/RemoteParts.tsx` (different signatures); two components named `Panel`
(`components/shell/Panel.tsx`, the window's card surface, and `components/primitives/Panel.tsx`, the tool-tab frame; both
set `data-panel`) and two named `Notice` (`primitives/Notice` and `review/parts.tsx`, which is an `EmptyState`): rename one
of each so one name means one thing.

**CSS.** A script listed every class selector in `styles.css` and searched all `.ts`, `.tsx`, `.html` and `.js` sources for
the name: 33 hits, of which 19 are Monaco's own classes (keep) and 7 are `octo-ctx-*` built as `` `octo-ctx-${key}` `` (keep).
The rest is finding 4.

**Feature-flagged tabs** (not junk; off by default in `DEFAULT_TAB_FLAGS`, `packages/ui/src/lib/tabFlags.ts`): `sessions`,
`agents`, `notes`, `details`, `usage`, `memory`. Their code: `components/agents` (187 lines), `notes` (611), `details` (793),
`usage` (466), `memory` (1,749), and the Sessions tab in `components/sessions`. `?tabs=all` turns them on; Settings still
uses Usage and Memory pieces.

**Leftovers of the bundle work.** `components/chat/readyLazy.ts` (finding 10). The `*More.ts` modules (`lib/modelsMore.ts`,
`toolsMore.ts`, `hooksMore.ts`, `matchMore.ts`, `orchestratorMore.ts`, `providers/providersMore.ts`,
`primitives/statusMore.tsx`, `demo/reviewMore.ts`; 552 lines) are deliberate splits that keep code out of the entry: keep.
`components/chat/CommentsControlLazy.tsx` and `LazyMarkdown.tsx` are lazy wrappers in use: keep.

**Scripts.** Every `.mjs` script parses (`node --check` on all of `packages/ui/scripts`, `apps/desktop/scripts`,
`apps/web/scripts`, `scripts/`: no failure). Whether each Playwright script and tour state still passes against today's UI
was **not run** (they need a dev server and a browser; none runs in CI). `packages/ui/scripts/dropdown-scroll.mjs` is named
only in the UI spec, not in `AGENTS.md` or any doc that lists the scripts (keep; add it to the list).

## Go

**Tools run** in `apps/harness` with `GOTOOLCHAIN=auto`: `go vet ./...` (no findings, exit 0);
`go run golang.org/x/tools/cmd/deadcode@latest -test ./...` (21 functions); `deadcode ./...` without tests (118 functions
unreachable from the binaries; the 97 that are not in the list below are reached by tests: test seams such as `bridge.WithBuiltinLoop`, `WithPingInterval`; keep unless reviewed);
`go run honnef.co/go/tools/cmd/staticcheck@latest ./...` (14 findings). The runs touched `go.mod` (`golang.org/x/sys` moved
to a direct requirement); that change was reverted.

**Unreachable even from tests** (finding 3; file:line, function, lines with its doc comment):

| Function | Lines | Function | Lines |
| --- | --- | --- | --- |
| `internal/acp/model.go:151` `configOption.values` | 14 | `internal/project/files.go:150` `Files.ReadBytes` | 5 |
| `internal/codehost/remote.go:110` `WithRepoHint` | 5 | `internal/project/files.go:167` `Files.Write` | 4 |
| `internal/datalock/datalock.go:45` `Lock.Path` | 12 | `internal/project/history.go:18` `Service.Compact` | 8 |
| `internal/gitx/gitx.go:291` `UpdateRef` | 5 | `internal/project/queue.go:38` `Service.EditQueued` | 14 |
| `internal/mockllm/stream.go:99` `streamReply` | 3 | `internal/project/queue.go:61` `Service.ResumeQueue` | 7 |
| `internal/orchestrator/history.go:62` `messageParam` | 4 | `internal/project/sessions.go:237` `Service.CreateSession` | 13 |
| `internal/orchestrator/images.go:117` `imageIDs` | 10 | `internal/project/sessions.go:251` `Service.ResumeSession` | 8 |
| `internal/project/attachments.go:109` `Service.PostMessageWith` | 35 | `internal/project/slash.go:70` `Service.CompactViaAgent` | 15 |
| `internal/project/files.go:48` `Files.root` | 4 | `internal/providers/discover_test.go:89` `discRig.requests` | 7 |
| `internal/project/files.go:54` `Files.rootFor` | 4 | `internal/router/router.go:37` `WithHTTPClient` | 33 |
| `internal/project/files.go:108` `Files.List` | 3 | | |

**staticcheck**, beyond the unused functions above: `internal/orchestrator/acp_orch.go:73` "empty critical section"
(SA2001; deliberate: it waits for a digest that holds the lock; keep), `internal/orchestrator/secrets.go:118` capitalised
error string (ST1005), and six findings in test files (an unused type, field, method and value, two style hints).

**Routes with no caller.** Every route registered in `internal/bridge` and `internal/remoteaccess` (167) was matched against
the sources of `@octo/agent-client`, `@octo/ui`, `apps/web` and the scripts. Only `GET /v1/projects/{pid}/notes/{nid}/export`
has no caller; it is documented in `apps/harness/docs/memory.md` (probably dead in the UI, may be intentional API).

**Examples and plugins.** `examples/fakeacp` and `examples/mockllm` are used by the e2e scripts and the dev stack (keep).
`examples/remotetool` (51 lines) is named in `apps/harness/README.md` and `docs/architecture.md` as the demo of `--remote`
(keep, manual). `plugins-examples/{acp-agents,fake-acp,go-tools,typescript-tools}` are documented examples; `fake-acp` is
read by `internal/plugins/load_test.go` (keep).

**Settings and variables.** Every `os.Getenv` / `LookupEnv` name outside tests is in the table of
[`ARCHITECTURE.md`](ARCHITECTURE.md#environment-variables-and-settings) except test-only names (`OCTO_FAKEACP_*`,
`HARNESS_TEST_*`, `DATALOCK_HOLD`, `OCTO_UPDATE_FIXTURES`). Whether every setting id is still read was **not checked**.

**Old migrations.** The `migrate_v*.go` steps must stay: a database of any older schema still opens. The `.pre-m6` and
`.pre-v15` backups on users' disks are kept for good by design (nothing in the code deletes them).

**Skipped tests.** 46 `t.Skip` calls, all conditional on the environment (no `sh`, `git`, `gopls`, `/proc`, symlinks,
POSIX modes, a free port); none is unconditional.

## Rust

- `cargo check -p octo` with `CARGO_PROFILE_DEV_DEBUG=0` and a scratch target directory: **0 warnings** (1 min 34 s; the
  390 MB target directory was deleted afterwards). Clippy runs with `-D warnings` in CI.
- `cargo machete` and `cargo udeps` are not installed; installing them means a long build, so they were **not run**. A
  grep for each dependency of `apps/router/Cargo.toml` in `src/` found every one used.
- Config keys: every `key =` of `apps/router/config/*.toml` appears in `src/` (grep). Not proof that each is read, but no
  orphan name.
- `apps/router/experiments/` holds only `.gitkeep`; `scripts/claude-code-env.sh` creates and uses it (keep).
- `apps/router/ml/` is the thesis study (keep). Sizes: models 23 MB (`m2_delegation.onnx` 23,010,101 bytes, `m1_joint.onnx`
  27 KB), results 3.0 MB, figures 2.8 MB, 30 MB in all. Its `stage6_*.py` files and `xbench_fetch.py` are run through
  `make` targets as modules, so their file names appear nowhere else (keep).
- The router's `#[cfg(test)]` modules in `src/cli.rs`, `src/auto/action.rs`, `src/proxy/error.rs` contradict its own rule
  (below).

## Repository

**Duplicate rule files.** `.claude/rules/typescript.md` and `.cursor/rules/octo-typescript.mdc` have the same body (a diff
after the front matter differs only in the comment that names the other file); each tool needs its own front matter. Keep
both; the comment already says "change both".

**Committed artefacts.** No binaries outside test data (`internal/remoteaccess/testdata/fake-cloudflared` is a script).
Largest tracked files: `docs/superpowers/specs/2026-11-10-project-harness-ui.md` (519 KB, about 4,800 lines: the UI spec
with every decision and "As built" section), `apps/router/ml/models/m2_delegation.onnx` (23 MB, the study's model),
`apps/router/ml/results/stage5_xbench.json` (467 KB), `docs/images/octo-{dark,light}.png` (400 KB each, used by
`README.md`). Recommendation: keep; consider moving the oldest "As built" sections of the UI spec to an archive file.

**Broken links in old docs** (the link checker of this pass, run over every tracked Markdown file): two, both in files of
finding 13's kind: `apps/router/docs/superpowers/plans/2026-11-03-openai-chat-proxy.md` links `../../AGENTS.md` (no such
file from there) and `apps/router/docs/verification/2026-11-06-autoroute.md` links `bc-eed6c010-...` (a session id, not a
file). Not fixed (history).

**Documents nothing links to** (a search of every tracked text file for the file name): the two router docs of finding
13. All of `docs/superpowers/specs`, `research` and `plans` are now in the specs index of `ARCHITECTURE.md` (four were
missing and were added). Older history worth archiving rather than deleting: `apps/router/docs/{plans,research,debug,
verification,experiments}/2026-11-0*` and `docs/superpowers/plans/2026-11-09-harness-bridge-phase2.md` (superseded).

**TODO / FIXME / XXX / HACK.** 0 in Go, Rust, the router's Python and every script; 4 in `packages/ui`, all of them the
demo language server's `TODO(error)` marker and a test of the string "TODO". No comment describes unfinished work.

**Scripts not in CI.** `apps/harness/scripts/e2e-parity.sh`, `e2e-remote.sh`, `e2e-sessions.sh` (fixed ports; documented in
the specs and `HANDOVER.md`), `apps/web/scripts/phone-flow.*`, all `packages/ui/scripts/*`, `apps/desktop/scripts/traffic-lights.mjs`,
`make test` of `apps/router/ml`. All parse (`bash -n`, `node --check`); whether each passes today was **not run**.

## Contradictions between documents

| # | One says | The other says | Settled? |
| --- | --- | --- | --- |
| 1 | `packages/ui/AGENTS.md`: "the bundle budget in `scripts/check-bundle-size.mjs` is never raised" | The script's header and `HANDOVER.md`: "The budget was raised by hand as features landed" (now 161.00 kB) | Yes: AGENTS.md corrected to "raised only by hand with a reason" |
| 2 | `apps/router/AGENTS.md`: "Do not add `#[cfg(test)]` modules in `src/`" | `src/cli.rs`, `src/auto/action.rs`, `src/proxy/error.rs` have them | No: either the rule or the code changes; code not touched |
| 3 | `specs/2026-11-13-learned-router-design.md`, line 4: "Status: **designed, nothing built.**" | The same file, "As built — the data path at the delegation boundary (2026-11-20)": records, outcomes, label, export and escalation are built | No: the status line is stale; specs were not edited in this pass |
| 4 | `apps/desktop/AGENTS.md`: "four commands" | `src-tauri/src/lib.rs` registers five (`chrome_debug`) | Yes: corrected |
| 5 | `packages/ui/ARCHITECTURE.md`: "Reserved, being built: `FieldRow`. Not yet built: ... `ListDetail`" | Both exist in `components/primitives` with 4 and 5 importers | Yes: corrected |
| 6 | `packages/ui/src/components/primitives/glyphs.ts` comment: "File types live in `files/fileIcons.ts`" | The file is `components/primitives/fileIcons.ts` | No: a code comment; not touched |
| 7 | `docs/ARCHITECTURE.md` (2026-11-19): `@octo/web` and `@octo/agent-client` "are still 0.1.0" | Both `package.json` files say 0.2.0 | Yes: corrected |
| 8 | UI spec numbers the branch picker decision 100 | Code comments (`internal/project/branches.go`, `BranchPicker.tsx`, ...) say "decision 98" | No (already listed in ARCHITECTURE.md, item 9) |

## Plan

In order of benefit for the effort. Line counts are estimates from the files named above.

1. **Delete the unused UI files and functions** (findings 1, 2, 5, 10): about 180 lines; then `pnpm lint`,
   `pnpm --filter @octo/ui test`, the desktop build and `check-bundle-size.mjs`.
2. **Delete the 21 unreachable Go functions** (finding 3): about 210 lines; then `gofmt -l`, `go vet`, `go test ./...`.
3. **Delete the unused CSS** (finding 4) after one look at the demo's Home and Details screens: about 65 lines; then
   `spacing-audit.mjs` and `frame-colours.mjs`.
4. **Merge the duplicates** (findings 6, 7; rename the second `Panel` and `Notice`): about 40 lines less, and one name per
   thing; check the texts that change (`formatBytes`).
5. **Finish the deprecated-alias migration** (finding 11), then delete the aliases: about 30 lines and 17 call sites.
6. **Decide on the legacy CLI** (finding 8): about 410 lines of source plus about 100 of tests, and a section of the
   harness README.
7. **Drop `@tauri-apps/plugin-opener`** from `apps/desktop/package.json` (finding 9) if the frontend will not call it; and
   `calibrate.py` (finding 12) if no one runs it.
8. **Archive** the router's early docs and the superseded plan (finding 13); fix the stale status line of the learned-router
   spec and the `cfg(test)` rule (contradictions 2 and 3).

Steps 1 to 4 remove about 500 lines with no change in behaviour (step 4 changes some byte-size texts); steps 5 to 7 about
550 more after the owner's decision.
