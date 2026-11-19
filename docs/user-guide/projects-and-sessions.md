# Projects and sessions

## Projects

A **project** is a name, one or more folders on your computer, the agent and models it uses, a permission level, and optionally
a budget and a list of commands. It is not a copy of your files: the agent works in your real folders.

- **New project** (Home, or the sidebar): choose the folder from Recent, type a path, or press **Browse…** for the system's folder
  dialog. On Linux the dialog needs `zenity` or `kdialog`; without a display the list and the typed path still work.
- **Several folders.** A project can hold more than one folder, for example a service and its facade. Names that begin the same
  stay apart in lists (the part that differs is kept: "product-co…management-system" and "product-co…facade-service"); the full
  name is in the tooltip. The status bar says "2 folders" and lists them in its tooltip. An agent's own session starts in the
  project's first folder, and file access is confined to the project's folders.
- **Project settings** (the project's "⋯" menu): name, folders, permission level, models, budget, the **Always allowed** list,
  commands. Changes apply from the next request.
- **Delete project…** removes the project's history from Octo. It does **not** touch the files in your folders.
  See [Privacy and data](privacy-and-data.md#delete-things).

If a project's folder is gone, Octo says "The project folder <name> is missing" and what to do: put the folder back where it was,
or remove it from the project. If a project's saved data is damaged or unreadable, the project is listed as **unavailable** with
the reason and the path of any backup; Octo leaves the file untouched ([Troubleshooting](troubleshooting.md#a-project-is-unavailable)).

## Sessions

A **session** is one conversation with an agent in a project. A project has as many as you like.

- **Every session is open and can run at the same time.** The sidebar is a tree of projects and their sessions (Settings →
  General → "Sidebar shows" switches to projects only, or a flat list of sessions). A session that waits for you or failed is
  listed first in the flat view.
- **New session** makes an empty one. A session's title comes from its first request; "New session" is the title until then.
- **Running limits.** A project runs at most 3 turns at once and Octo at most 6 across all projects
  (`HARNESS_MAX_RUNNING_SESSIONS`). A further message waits in its session's queue and says "Waiting for a free slot".
- **Default session.** The default is where a message goes when no session is named. **Make default** (the session's menu)
  changes it. You cannot archive or delete the default one, or one that is running.
- **Rename, archive, delete.** Deleting a session removes its conversation from Octo; what you wrote to Memory about it stays.
  **Settings → Privacy and data → Delete all sessions** removes every session of every project.
- **`/clear`** starts a new session that carries a short summary (at most about 600 tokens) of the old one. The old session is
  kept whole and can be opened and continued.
- **Resume.** Opening an old session and writing in it continues it. For an agent that supports it, Octo resumes the agent's own
  session; otherwise it rebuilds the context from a recap **(not verified with a real agent)**.
- **Import sessions** (Settings → Privacy and data) brings in conversations kept by other tools for the same project folders
  (Claude Code, Codex, Gemini, OpenCode stores under your home directory). Already imported ones are skipped.

## The branch chip and worktrees

On the new-session screen of a project that is in a git repository, the composer shows a **branch chip**: the branch your main
checkout is on (a short commit when detached). It is read again when you focus the window, after a turn ends and when you open
the picker. It does not poll.

Open the chip to pick a branch, search, or **Create branch "x" from <current>**:

- **Switching** runs `git switch` in your main checkout, only when nothing can be lost: your tracked files are clean and no
  session is working in that checkout. Otherwise Octo changes nothing and tells you why ("The main checkout has uncommitted
  changes, so it stays on its branch", or "A session is working in the main checkout…"), with a button **Start in a worktree from
  <branch>**. Octo never forces, stashes, discards or commits for you. Untracked files do not block a switch; git refuses by
  itself if one would be overwritten.
- **Worktrees** run a session in a separate checkout of a branch, so parallel sessions do not disturb each other or your main
  checkout. Choose a branch under "In a new worktree", or use **Move to worktree…** on an empty session. The session's chip then
  shows the worktree's branch. A project with several git folders gets one worktree per repository.
- Octo has **no button that applies a worktree's work back** to your main checkout. Do that with git.

**Verification.** Switching, creating, both refusals and moving a session into a worktree were run against a real repository with
the mock model, in Chromium on Linux. Not verified: macOS and Windows paths, repositories with thousands of branches, a real agent
working in a worktree.
