# Parity backlog — what we add after comparing with OpenCode and Cursor

**Date:** 2026-11-12 · **Status:** approved to build (owner: "check our features against OpenCode and Cursor … and add
them to us") · **Source:** [`../research/2026-11-12-feature-comparison.md`](../research/2026-11-12-feature-comparison.md)
(a sub-agent's report; OpenCode was run without a model, Cursor is from its public docs only).
Ideas are adapted; no code, text or assets are copied.

## Order and contracts

**B1 — the agent can read the project's instructions** (S). The built-in loop and sub-agents get the project's
instruction files in their system prompt: `AGENTS.md` (also `CLAUDE.md`) from each project folder root and, for a
file-scoped task, from the directories between the root and the files it touches; 32 kB cap per file, 64 kB in total,
nearest file last; changes are picked up on the next request; the context receipt lists them. ACP agents read their
own instruction files — we add nothing there, and say so in the UI's context view.

**B2 — real editing tools** (S). `edit` (exact string replacement, must be unique unless `replace_all`; the diff goes
to changes/approvals like `write_file`), `glob`, and `web_fetch` (text only, size-capped, off unless the project
allows network; never sends project content). Sub-agents get `edit` and `glob`.

**B3 — Ask and Plan modes** (M). Project/turn `mode`: `agent` (today), `ask` (read-only: no writes, no shell
writes, no delegation that writes), `plan` (read-only; the answer is a plan the user can approve — approval starts
an `agent` turn with the plan pinned). Enforced in the harness tool gate, not by prompt alone; for an ACP
orchestrator `ask`/`plan` map to the agent's own mode when it advertises one, else its write permissions are denied.
UI: a mode chip in the composer, `Shift+Tab` cycles.

**B4 — "Always allow" and reject with feedback** (M). Approval answers gain `allow_always` (a saved rule per project:
tool + command prefix or path glob; listed and removable in Settings) and deny keeps its note, which is given to the
agent as the reason. Needed before the default access flips to `supervised`.

**B5 — rewind to a request** (M). From any earlier request: restore the files changed since it (using the recorded
changes), cut the conversation back to it, and put its text back in the composer. One confirm that lists the files;
refused with a clear reason when a file changed outside the harness since. Memory records of the cut turns are
dropped.

**B6 — steer a running turn** (M). "Send now" on a queued message delivers it into the running turn at the next
tool boundary (built-in loop); for ACP agents only if the protocol path exists — otherwise the button says it will
be sent when the turn ends.

**B7 — context and history** (S). A visible "history compacted" marker, a manual "Compact now", the context ring's
breakdown from the receipt; export a conversation to Markdown; search past requests (palette).

**B8 — notifications** (S). Desktop notification when a project finishes, fails or needs the user while the window is
unfocused (off until the user allows it once; Settings → General).

**B9 — quick open and search in files** (S). `Ctrl/Cmd+P` file quick-open across project folders; search in files
from the palette with results that open at the line.

**B10 — skills and custom commands** (M). `SKILL.md` folders and Markdown commands from the project and the user's
config directory, listed in the `/` menu; a skill's instructions load only when used.

Later, each needs its own design: per-hunk accept/reject, a standard MCP client for user-configured servers, hooks,
inline edit in the editor, an OpenAI-compatible provider, a worktree per sub-agent, a terminal pane, remote access,
a sandbox for the shell, scheduled runs, voice, a browser tool.

## Not copied (reasons in the report)

Hosted share links, account-bound cloud agents, vendor-specific model routers.
