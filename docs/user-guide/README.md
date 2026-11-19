# Octo user guide

For a person who installs Octo and uses it. If you want to change Octo's code, start at the
[repository README](../../README.md) and [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) instead.

## What Octo is

Octo is a desktop app that runs coding agents inside your project folders. An agent can be Octo's own loop, which calls a
model with your API key, or another agent program on your computer, such as Claude Code, GitHub Copilot or Grok, running on
your subscription. You choose per project. You see what the agent does, approve or refuse its edits and commands, review the
changes and undo them, and run several sessions at once.

Everything runs on your computer. Octo starts a small local service (the _harness_) that holds your projects and talks to the
agents. The only traffic that leaves your computer is the calls to the model or agent you chose. See
[Privacy and data](privacy-and-data.md).

## Read in this order

| Page | What it covers |
| --- | --- |
| [Install](install.md) | What `pnpm install:app` builds on macOS and Linux. There are no signed releases yet. |
| [First run](first-run.md) | The connect screen, adding an API key or an agent, and what "Ready", "Not running" and "Not logged in" mean. |
| [Projects and sessions](projects-and-sessions.md) | Projects with one or several folders, sessions, the branch chip and worktrees. |
| [Working with an agent](working-with-an-agent.md) | Modes, permission levels, the approval card, queue and stop, rewind. |
| [The tool tabs](tool-tabs.md) | Files, Changes, Review, Terminal, Browser, Processes, side question. |
| [Settings worth knowing](settings.md) | The settings that change how Octo behaves. |
| [Remote access](remote-access.md) | Using Octo from a phone, what it exposes, and what a paired phone may not do. |
| [Privacy and data](privacy-and-data.md) | Where data lives, what is stored, what leaves your computer, how to delete it. |
| [Troubleshooting](troubleshooting.md) | `harness doctor`, logs, and the common errors with their fixes. |
| [Keyboard shortcuts](keyboard-shortcuts.md) | The shortcut sheet, as a table. |

## How far this guide can be trusted

Every statement was checked against Octo's code or its feature documents on 2026-11-19. Octo itself has been verified in a
limited way, and the guide says so where it matters:

- Verified by the owner on Linux with a real agent: Claude Code (the app, the harness, the router, installing from source).
- Verified only with a mock model and scripted stand-in agents, in a Chromium browser on Linux: nearly everything else,
  including the whole interface of the last weeks.
- **Not verified with a real agent:** GitHub Copilot, Grok, Codex, Cursor, OpenCode, Antigravity, Devin, Droid, omp, pi
  (logged in), images sent to an agent, resuming an agent's own session, an agent asking for permission in "Ask first".
- Not verified on macOS in a release build, in Safari or WebKit, in the Tauri window, on Windows, with a real Ollama, or with a
  real tunnel and phone.

A line marked **(not verified with a real agent)** describes what Octo is built to do. If your agent behaves differently,
[tell the owner](troubleshooting.md#reporting-a-problem).
