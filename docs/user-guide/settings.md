# Settings worth knowing

Open Settings from the sidebar or **Ctrl/Cmd+K**. The sections are in three groups. A change shows "Saved" next to it. Some
apply at once; those that need Octo's local service to restart (an API key, the router) say so and Octo restarts it for you.

## App

- **General.** What the app shows on startup, and **Sidebar shows**: projects with their sessions (default), projects only, or
  sessions only. **Octo's local service** shows the connection to the harness and can restart it.
- **Appearance.** Theme (dark, light or follow the system), the start-screen backdrop, and **Reduce motion**.
- **Privacy and data.** Memory, the diagnostic report, the data folder, importing and deleting sessions, the wire trace and the
  environment passed to agents. See [Privacy and data](privacy-and-data.md).
- **Remote access.** Off after every start. See [Remote access](remote-access.md).
- **About.** Versions.

## Models and agents

- **Providers.** The list from [First run](first-run.md): connect an API key, check an agent, add model names you type yourself,
  and for each agent a preferred model and which model it uses for the fast, balanced and deep roles. Any model name can be
  chosen; if the agent refuses it, the turn says which models it does offer.
- **Models.** The models new projects start with, in two scopes (for new projects, and for the open project). The orchestrator
  is the main agent: a model id such as `claude-sonnet-5-5`, or an agent (`acp:claude-code`). **Fast**, **balanced** and **deep**
  are the tiers the main agent picks from when it delegates to helper agents. A project's tier models follow its agent when that
  agent is an external one. A tier whose provider is not connected says "provider not connected" under it.
- **Integrations.** Language servers, agents and tool servers that come from plugins.

- **Several accounts of one agent.** Settings → Providers → Claude Code (or Codex) → **Accounts**: give the account a
  name and a login folder (for example `~/.claude-work`), then run the login command its detail shows in a terminal. The
  account is listed as "Claude Code · Work" and can be chosen in any model picker, so one project or session can use your
  work login and another your personal one. Octo keeps only the name and the folder.

## Workspace

- **Editor.** **Compact folders** for the file tree. **Suggestions**: inline completion in the editor, off or on the **Small tier
  (Ollama)**, with the Ollama model tag (default `qwen2.5-coder:1.5b`) and server URL (default `http://127.0.0.1:11434`).
  Completion is the only thing Octo uses Ollama for. **(not verified with a real Ollama or a real model)**
- **Commands and review.** Named shell commands for the project ("Dev server", "Tests") that you start from the Processes tab, and
  the pull-request review options.
- **Memory.** Per project: **Auto-memory** and **Context mode**.
  - Auto-memory is **Off (ask first)** by default: Octo does not save notes or facts about your work by itself and asks when
    a model tries. **Review each item** asks for every write, **Allow automatically** saves without asking, and **Blocked for this
    project** turns memory off and hides it. Everything Octo remembers is in the project's data, never sent anywhere but to the
    model of that project when it is added to a request.
  - Context mode is **Full history** (every message, summarised when long; the default) or **Recent window** (the last few
    exchanges plus memory). The first version of Recent window measured 15% dearer than Full history on a real provider
    (owner's live run 2), and later versions were only tested with scripted exchanges.
- **Usage and budget.** Tokens and cost per model and per project, and **Budget**: a spend limit per project. Subscription agents
  show "≈ $X on your subscription", which is an estimate and never counts toward the budget. Usage depends on what each agent
  reports; limits on a subscription are not read.

## Per project

The project's "⋯" menu → **Project settings**: name, folders, **permission level**, models, **budget**, the **Always allowed**
rules you saved from approval cards ([Working with an agent](working-with-an-agent.md)).

## The Octo router (optional)

Settings → Providers → **Octo router** (the "Use the Octo router" switch): switch it on and add one provider key (for example OpenRouter's). The app then starts a
router first and points its own loop at it; the router chooses cheaper models for easy work, keeps a budget, and keeps a history
of calls. An external router URL can be given instead. Agents are not behind the router. With the router on, **the router stores
the text of requests and answers** in its own history database on your computer, by default
([Privacy and data](privacy-and-data.md#what-is-stored)).
