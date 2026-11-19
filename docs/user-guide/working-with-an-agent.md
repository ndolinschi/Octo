# Working with an agent

Under the message box of a session are three chips: the **mode**, the **permission level** and the **model** (which names the
agent and its model, never an id). A chip that is too narrow loses its label first; its tooltip keeps the name.

## Modes: Agent, Ask, Plan

The mode says what the agent may do in the next requests. **Shift+Tab** in the box changes it, or use `/mode`.

| Mode | What the agent can do |
| --- | --- |
| **Agent** (default) | Read, edit, run commands, and delegate to helper agents, subject to the permission level below |
| **Ask** | Read and answer only. Octo refuses edits and delegation, and refuses shell commands except one simple read-only command at a time (`ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find` without `-exec`, `git status`, `git log`, `git diff`, and a few more). A refused call raises no approval card |
| **Plan** | The same limits as Ask, and the answer is kept as a **plan** card. **Approve** the plan and a fresh Agent turn carries it out with the plan pinned in its instructions |

With an external agent Octo also asks the agent to switch to its own matching mode when it has one, and denies the agent's
write requests in Ask and Plan whatever the permission level **(not verified with a real agent: only the scripted agent
advertises modes)**.

## Permission levels: Ask first, Accept edits, Allow all

The level belongs to the project (Project settings, or the chip) and applies from the next request, also inside a turn that is
running. **New projects start at Ask first.**

| Level | Edits and writes | Commands and other actions |
| --- | --- | --- |
| **Ask first** | Ask | Ask |
| **Accept edits** | Allowed without asking (edit, write, delete, move) | Ask: shell commands, network fetches, other agent actions |
| **Allow all** | Allowed | Allowed |

Reading never asks. Helper agents ask at any depth, and only the agent that asked waits. Whatever the level, an agent is **not
sandboxed**: a command it runs has your rights on your computer. "Allow all" means you trust the agent and the folder.

## The approval card

When something needs you, a card appears above the message box and the session is marked "needs you" in the sidebar. It shows
what is asked (the file and a diff, the command, the host) and the actions **Allow once**, a **scope** button, **Always** and
**Deny**. The caption line opens the details; an edit opens straight on its diff.

| Action | What it covers |
| --- | --- |
| **Allow once** | This one request |
| **Scope button**: "Allow edits for this request", "Allow `echo` commands for this request", "Allow fetches from example.com for this request", "Allow commands for this request" | The same kind of request from the same agent for the rest of this request (the turn). For commands it is the same **program** (first word), and only for a **simple command**: no `;`, `&`, `|`, redirection, `$` or backtick expansion, subshell, line break or leading `VAR=`. A compound command such as `ls; curl … \| sh` never gets this button and is never remembered |
| **Always** | Saves a rule for this project and allows the request. For commands the rule is the first words (two for programs with subcommands, such as `git status` or `pnpm test`; the whole command for launchers such as `npx`, `go run` or `bash -c`); for files the exact path; for fetches the host. A compound command cannot be saved. Remove rules under Project settings → **Always allowed**; a removed rule stops applying at once |
| **Deny** | Refuses it. A note you add reaches a built-in agent ("Denied by the user: …"); an external agent only learns it was refused |
| **Allow all for this request** (shown on a group such as "3 approvals", with the agents' names) | Allows every waiting request and every further request of this turn, from any agent and of any kind |

Cancelling a turn denies what is pending. A request nobody answers for 30 minutes is denied (`HARNESS_APPROVAL_TIMEOUT`).
Waiting cards survive a window reload but not a restart of Octo. A request to remember something (when automatic memory is off)
shows its own card.

**Verification.** The scopes and rules were tested with the built-in loop and a scripted agent. An external agent asking for
permission in "Ask first" was never run for real; the scope wording for such an agent ("Allow commands for this request")
comes from the agent's own kind of request.

## Queue, stop, steer

- **Send** with Enter; **Shift+Enter** is a new line. While a turn runs, a message you send is **queued** (first in, first out,
  up to 20 per session) and shown above the box. **Ctrl/Cmd+Enter** queues on purpose.
- **Esc** stops the current reply. A stopped or failed turn **pauses** a non-empty queue; the queue row offers **Resume**, **Send
  now**, edit, remove and **Clear**. Stopping never drops a queued message.
- **Send now** on a queued message with the built-in loop **steers**: the message is added at the turn's next tool boundary
  without cancelling the turn. With an external agent steering is not possible; Octo then stops the turn and runs your message
  first.
- A reply you stop keeps what the agent had already written, marked as stopped.

## Rewind

Under a reply, **Restore to here** (or `/rewind`) undoes that request and every later one. First you see a preview of exactly
which files come back or are deleted. If any of them changed outside Octo since the agent last wrote them, **nothing** is
changed and the preview lists the conflicts. When it runs, the later messages and helper agents are hidden (they stay on disk but
are no longer shown, sent to a model, searched or exported), the recorded file changes are undone, and spend stays counted. An
external agent's own session cannot be cut, so the next request starts a new session with a recap. Content older than 30
days, or too large to keep, cannot be restored.

## Other things in the box

- `/` lists Octo's commands (`/mode`, `/model`, `/memory`, `/settings`, `/help`, `/new`, `/clear`, `/context`, `/compact`, `/rewind`) and the
  commands the agent advertises. `@` mentions a file; the "+" menu attaches a file or mentions one.
- **Images** can be pasted or dropped. An agent that does not accept images says so before sending and keeps your text
  **(which agents accept images: not verified with any real agent)**.
- The **context ring** and `/context` show what fills the model's window, itemised; **Compact now** shortens the history and says
  what it saved.
- **Budget.** A project can have a spend limit (Project settings). When it is reached, the turn ends with "This project's budget is
  used up" and nothing more is sent. Subscription agents report an estimate that is never counted as spend.
