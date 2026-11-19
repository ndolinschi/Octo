# The tool tabs

Beside the conversation, Octo opens tools as tabs: **Files**, **Changes**, **Review**, **Terminal**, **Browser**, **Processes**
and the **side question**. Open one with **Ctrl/Cmd+T** (the "+" tab menu) or the command palette (**Ctrl/Cmd+K**). Drag a tab to
the other side or out of its group; **Ctrl/Cmd+Shift+Enter** maximises the tab you are in and **Esc** restores it.

Every tool tab has the same top bar: a small (i) button that says what the tab is for, then what the tab shows, then its actions on
the right. Tabs have no title in the bar. The sidebar and the file-tree column can be resized (drag the edge; the arrow keys move
it by 16 px, Shift by 64; a double-click resets it).

Six more tabs (Sessions, Agents, Notes, Details, Usage, Memory) are switched off in the interface by default; their content is in
the sidebar and in Settings (Usage and budget, Memory). This is a display choice only; nothing is disabled in Octo itself.

## Files

A tree of your project's folders and an editor (Monaco, the editor of VS Code) with syntax colours and, when a language server is
installed, errors and completions.

- **Open** a file by clicking it. The tree stays a column on the left; opening a file changes only the editor.
- **Compact folders.** A chain of folders that each hold only one folder is one row: `src/main/java`, and inside a Java source
  root `com.example.app` (like IntelliJ's compact middle packages). Settings → Editor → File tree → **Compact folders** turns it off.
- **Save** with Ctrl/Cmd+S. If the file changed on disk meanwhile, Octo says so instead of overwriting it.
- **Add to chat.** Select lines in the editor (or put the caret on one), open the editor's context menu and choose **Add to chat**:
  the lines go into the message box as a mention such as `@src/auth/refresh.ts:9-14`, and the caret moves there. A file in the
  tree has the same entry (the whole file) and **Copy path** in its right-click menu.
- **Comments.** Ctrl/Cmd+Alt+C comments on the selected lines; pending comments are appended to your next message as a block the
  agent reads.
- **Limits you will meet.** The tree has **no rename, delete or new file or folder**. Octo does not watch the file system: a file
  made outside Octo (a terminal, another editor) shows in the tree only after its folder is listed again. Writes into a `.git`
  folder are refused.

## Changes

Every file change an agent makes in your folders is recorded per request: the file, who changed it, `+added −removed`, and a
diff. Changes made by shell commands and by an external agent's own tools are recorded too (by comparing before and after).

- **Revert** undoes one file or a whole request ("Revert turn"), after a confirmation. A reverted file shows "Reverted".
- A revert is **refused** if the file is no longer what the agent left ("file changed since") or if the original was not kept
  (too large, or older than 30 days). Nothing is half done.
- To undo a request **and its conversation**, use [Rewind](working-with-an-agent.md#rewind).

## Review

Reads and reviews pull requests through the **GitHub CLI (`gh`)**. Install it and log in (`gh auth login`) first; Octo stores no
token. Octo needs the folder's git remote to point at GitHub (or a GitHub Enterprise host).

- The picker lists open pull requests with filters ("To review" and others) and search; **Open by address or number**; a
  repository menu appears when the folder has several repositories (a fork and its parent). **Local branches** is the second view.
- An open review shows the files with thread counts, inline threads, and a diff. Keys: `J`/`K` next and previous change, `]`/`[`
  next and previous file, `N`/`P` threads, `V` mark viewed, `C` comment, `S` suggest a change.
- **Check out** gives a read-only workspace or a branch in your folder; Octo lists dirty files first. A review's checkout lives
  in Octo's data folder and never touches your working tree, index or branch.
- **Submit review** is the only thing that writes to GitHub, and only when you press it. No agent can submit.

**Verification.** Listing and reading a pull request was run by the owner on a GitHub Enterprise host. **Posting a review was never
verified**: test it on a pull request you can delete. Everything else was run against a fake `gh`.

## Terminal

A real interactive shell in your project folder (`$SHELL`, or `COMSPEC` on Windows), opened with **Ctrl/Cmd and the backtick key** (above Tab on most
keyboards); add **Shift** to open another in a new tab. Up to 8 per project. You start it and only you can: no agent can open or type into a terminal. Its
environment is filtered like an agent's (no provider keys), and it is not sandboxed. Terminals end when Octo quits; if Octo is
killed, the next start stops a terminal that was left behind.

## Browser

Shows a local web page (`localhost`, `127.0.0.1`) or another `http`/`https` page inside Octo, through a small local proxy, with
a **Design mode**: pick an element, read its styles and component, edit text in place, draw notes and take cropped screenshots,
then send them to the conversation. No agent can drive the browser, read its cookies or click; an agent receives only what you
stage and send. An unreachable page shows a message with **Retry**. The tab is not available from a paired phone.

## Processes

Lists what runs for the project and who started it: your commands ("Running · by you · pnpm dev"), terminals, language servers
("by the editor") and agent workers ("by" the session's title). **Stop** and **Kill** show on hover or focus (always on touch).
**Commands** are named shell commands you define under Settings → Commands and review ("Dev server", "Tests") or type once. Only you
start a run; it needs no approval even in "Ask first".

## Side question

**Ctrl/Cmd+;** asks a quick question about the code in a read-only session of the project's own agent. It is not added to the
conversation and has its own stop. **Keep** pins an answer and **Clear** empties the list. If nothing can answer, one notice says
so. **(not verified with a real agent)**
