# Own desktop app with a built-in code pane — design

**Date:** 2026-11-10
**Status:** approved (owner decision: "build our own and embed Monaco"; details decided by the orchestrating agent)
**Supersedes:** [`2026-11-10-vscode-agents-window-design.md`](./2026-11-10-vscode-agents-window-design.md) (VS Code fork — shelved)

## Intent

Octo stays its **own app** (`packages/ui` hosted by `apps/desktop`). People do not write
much code by hand in an agent-first tool, so instead of a full IDE the app gets a
**code pane**: browse the project's folders and view or lightly edit files with the
Monaco editor, next to the conversation.

## Goals

- Browse every folder attached to a project; open files in tabs; edit and save.
- File paths mentioned in tool rows open in the code pane.
- Files changed by agents refresh in open, unmodified tabs.
- All file access goes through the harness bridge, confined to the project's folders.
- Monaco is bundled locally (works offline, inside Tauri) and loaded lazily.

## Non-goals

- Language servers, debugging, terminals, extensions, git UI, search across files.
- Diff review of agent changes (a later "Changes" tab).
- Creating, renaming or deleting files from the UI.

## Bridge API additions

All under `/v1/projects/{pid}`; `folder` is a folder label, `path` is relative to it
(`""` = folder root). Paths are confined exactly like the agents' file tools (symlink
escape rejected). Errors use the existing JSON error shape.

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/files?folder=&path=` | → `{ "entries": FileEntry[] }` — one directory level, directories first, then by name; `.git` omitted |
| GET | `/files/content?folder=&path=` | → `FileContent`; `413 file_too_large` over 2 MiB; `415 binary_file` for non-text |
| PUT | `/files/content` | `{ folder, path, content, expected_mtime? }` → `FileStat`; `409 file_changed` if `expected_mtime` is given and differs from the file's current mtime; creates no parent directories |

```ts
type FileEntry = { name: string; path: string; type: "file" | "dir"; size: number };
type FileStat = { folder: string; path: string; size: number; mtime: string };   // RFC 3339, nanosecond precision
type FileContent = FileStat & { content: string };
// new SSE event
type FileChangedEvent = { type: "file.changed"; seq: number; folder: string; path: string; source: "user" | "agent" };
```

`file.changed` is published after a successful `PUT` (`source: "user"`) and after an
agent's `write_file` tool call finishes without error (`source: "agent"`).

`@octo/agent-client`: `Bridge.listFiles(projectId, folder, path)`,
`readFile(projectId, folder, path)`, `writeFile(projectId, { folder, path, content, expected_mtime? })`;
the three methods are added to the message-bridge allow-list; the reducer ignores
`file.changed` apart from `lastSeq`.

## UI

- The side pane gains a third tab, **Files**, next to Agents and Notes.
- Files tab = a file tree (one root per project folder, directories load on expand)
  and, once a file is opened, an editor area with a tab per open file. The pane is
  resizable by dragging its left edge; width is remembered. With a file open the pane
  takes roughly half the window by default.
- Editor: Monaco with neutral dark/light themes derived from the UI tokens, language
  by file extension, `Ctrl/Cmd+S` saves, a dot marks unsaved tabs, closing an unsaved
  tab asks first. A `409` on save offers "Reload from disk" or "Overwrite".
- On `file.changed` for an open file: unmodified tab reloads silently; modified tab
  shows a quiet "Changed on disk" notice with a Reload action.
- Too-large or binary files show a one-line explanation instead of an editor.
- File paths in tool rows are links that open the file in the Files tab (opening the
  pane if needed). An embedding host may still override this through `host.openFile`.
- Projects without folders show a short empty state in the Files tab.

## Acceptance criteria

1. **Confinement.** File endpoints cannot read or write outside a project's folders
   (path traversal and symlink escape tests), and unknown folders return `404`.
2. **Edit round trip.** Against the real harness: open the Files tab, expand a folder,
   open a file, edit, save — the file on disk has the new content.
3. **Conflict safety.** Saving over a file that changed on disk is refused with a
   choice to reload or overwrite; nothing is silently lost.
4. **Agent changes show up.** After an agent `write_file`, an open unmodified tab shows
   the new content without a manual refresh.
5. **Links.** Clicking a file path in a tool row opens that file in the editor.
6. **Offline and light.** No network requests for the editor; Monaco is in a lazily
   loaded chunk and the initial bundle grows by no more than ~15 kB gzip.
7. **Fits in.** Same neutral visual language in dark and light; keyboard reachable;
   no console errors.
8. **Quality gates.** Go vet/race tests, agent-client tests, UI lint, desktop build all pass.
