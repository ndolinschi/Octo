# Editor and agent-app UI references (2026-11-11)

A sub-agent's sourced report (official docs and changelogs where reachable, otherwise secondary sources); **not
re-verified by the orchestrator**. "Unverified" marks claims without a primary source. Used for decisions 45–48 of
[`../specs/2026-11-10-project-harness-ui.md`](../specs/2026-11-10-project-harness-ui.md). Adapt ideas; copy nothing.

| Product | Confirmed from primary pages | Unverified |
| --- | --- | --- |
| Cursor 2.x/3.x | Agents sidebar; agents in worktrees/remote; Agents Window "centered around agents" with the IDE one switch away; multi-file change view; Tab: accept all / `Esc` / accept word; Design Mode element picker | Working-state visuals; accept/reject granularity |
| Claude Code desktop | Session sidebar, worktree per session, split view; file-by-file diff with line comments sent as a batch; shortcut sheet; buttons overflow into a menu when narrow; OS notification when a session finishes unfocused | Motion details |
| Antigravity | Artifacts (plans, diffs, diagrams, recordings) with inline comments before changes; pause at milestones | Agent Manager layout |
| Zed | Edit predictions: eager/subtle modes, accept all/word/line keys, per-provider debounce (0–150 ms), status-bar indicator | Agent panel visuals |
| Windsurf | — | Review UI (docs moved) |
| Codex app | Chat/Work toggle, scheduled tasks | Worktrees, in-thread diff review |
| T3 Code | — | Everything (secondary sources only) |
| Gemini | CLI: thinking indicator cycling brand colours over ~4 s; setting to disable loading phrases | App edge glow (leak coverage) |

CSS guidance (MDN, web.dev): animate only `opacity` and `transform`; blur is expensive to paint, so paint it once and
move it; register the gradient angle with `@property` (`syntax` and `inherits` are both required); honour
`prefers-reduced-motion: reduce`; use `will-change` only when a problem is measured.

Sources: cursor.com/changelog/2-0, cursor.com/changelog/3-0, cursor.com/docs/tab/overview,
code.claude.com/docs/en/desktop, antigravity.google/docs/artifacts, zed.dev/docs/ai/edit-prediction,
learn.chatgpt.com/docs/app, developers.googleblog.com/en/making-the-terminal-beautiful-one-pixel-at-a-time,
developer.mozilla.org/en-US/docs/Web/CSS/@property,
developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion, web.dev/articles/animations-guide.
