# Privacy and data

Octo keeps your projects, conversations and settings **on your computer**. This page says where, what is stored, how the files
are protected, what leaves your machine, and how to delete things.

## Where your data lives

The desktop app keeps everything outside the app, so updating or reinstalling does not remove it. `<app data>` is:

| System | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/com.ndolinschi.octo.desktop` |
| Linux | `$XDG_DATA_HOME/com.ndolinschi.octo.desktop`, usually `~/.local/share/com.ndolinschi.octo.desktop` |
| Windows | `%APPDATA%\com.ndolinschi.octo.desktop` |

(The Linux and macOS paths are the installer's own; Windows is what `harness doctor` looks for and is not a supported install.)
Settings → Privacy and data → **Data folder** shows the exact path and copies it.

| Inside `<app data>` | What it holds |
| --- | --- |
| `harness/registry.sqlite` | The list of your projects |
| `harness/projects/<id>/project.sqlite` | One project's history (below) |
| `harness/projects/<id>/shadow/`, `secrets.json` | Copies of files from before an agent changed them (up to 256 MiB per project); secrets you gave a form |
| `harness/harness.env` | Your settings, including the API key and the router's provider key |
| `harness/api-token` | The token the app uses to talk to its local service |
| `harness/remote/devices.json` | Paired phones (a hash of each token, never the token) |
| `harness/traces/` | The wire trace, only while you have it switched on |
| `harness/agent-models.json`, `harness/children.json` | Models agents advertised; terminals and runs currently open |
| `router/` | The optional router's configuration and `history.sqlite` |
| Review checkouts, worktrees | Under `harness/projects/<id>/` (`review/`, `worktrees/`) |

The **logs** (`harness.log`, `router.log`) go to the app's log folder, which is Tauri's default for the app: on macOS
`~/Library/Logs/com.ndolinschi.octo.desktop`, on Linux a `logs` folder inside `<app data>` **(not checked on an installed
app)**. Each is capped at 2 MiB with one older copy kept.

Run from the repository (`pnpm dev:all`), the data folder is `./data/harness` instead.

## What is stored

- **Every message of every conversation**, verbatim, per project: your requests, the agents' answers and tool results, the
  files and images you attach. Octo removes the secrets you entered in a form, and anything its redactor recognises as a secret,
  before storing memory notes, facts and search text; do not rely on that for text you paste into a message yourself.
- Which agents ran, what they cost (tokens, money, or an estimate for subscription agents), and the changes they made, with a
  copy of the file from before.
- What Octo **remembers** about the project: task records, facts, notes and memory files, and a search index. By default Octo does
  not write these by itself ([Settings worth knowing](settings.md)).
- Your approval rules ("Always allowed") and your project commands.
- With the **router** on, the router also stores the text of requests and answers it proxies, in `router/history.sqlite`, and call
  records for 30 days. This is the router's default (`store_payloads = true`) and the app does not change it; whether it should
  is an open decision for the owner.

## How files are protected

On macOS and Linux, folders under the data folder are readable by you only (mode `0700`) and files too (`0600`): databases,
backups, attachments, secrets, traces, worktrees, logs. `harness.env` is refused if it is readable by others. At every start Octo
tightens modes it finds too open (up to three levels down). This does not apply on Windows.

Nothing encrypts these files. Anyone who can read your account's files, or a backup of your disk, can read your conversations
and your API key. Use your system's disk encryption.

An agent is a program running as you. It can read any file you can read. Octo confines the files it serves to an agent to your
project folders and refuses writes into a `.git` folder, but it does **not** sandbox the agent's own commands.

## What leaves your computer

Only these:

- **Calls to the model or agent you chose.** Your messages, the files and tool results the agent reads, and your attachments go to
  that model provider, or to the agent program, which talks to its vendor. Octo's own loop sends them to Anthropic (or the gateway
  or router URL you configured). External agents (Claude Code, Copilot, …) send what they read to their vendors under their own
  terms; Octo cannot see or limit that.
- **The router's upstream calls**, if you switch the router on: to your provider (for example OpenRouter), and, when that
  provider is OpenRouter, a refresh of the price list every 6 hours.
- **`gh` calls** when you use Review, to the GitHub host of the folder's remote.
- **A web page an agent fetches**, if you turn the project's network option on (off by default; it asks per host in "Ask first").
- **Pages you open in the Browser tab.** Images in an agent's Markdown reply from other sites are **not** fetched until you press
  "Load image" on the chip.
- **Remote access traffic through Cloudflare**, if you turn it on ([Remote access](remote-access.md)).
- **Model discovery.** When an agent becomes ready, Octo opens a short empty session with it to read its model list. No prompt is
  sent.

Octo itself has no telemetry, analytics, crash reporting or update check: none was found in the code (searched 2026-11-19).
The only other service Octo talks to is the local one on your computer.

## Copy a diagnostic report

Settings → Privacy and data → **Copy diagnostic report** copies versions, your system, what Octo found for each agent (a
command, a login check result), the names (never the values) of the provider variables that are set, and the last 200 log lines
with credentials removed. `harness doctor` prints the same on the command line. Read it before you send it to anyone.
**Record what agents send and receive** (the wire trace) writes each agent session's messages to `harness/traces/`, with emails
and tokens removed but **prompt text and file contents kept**: switch it on only to diagnose a problem, and read a trace before
sharing it.

## Delete things

- **A conversation:** delete the session (its menu). Memory about it stays until you remove it from Memory.
- **All conversations:** Settings → Privacy and data → **Delete all sessions** (every project; refused while any session runs).
- **A project's data:** the project's "⋯" menu → **Delete project…**. This removes the project's whole folder under
  `harness/projects/<id>/` (history, memory, saved file copies, secrets, review checkouts) and its row in the registry. **Your own
  files in the project's folders are not touched.** Stop the project's running sessions first. If the project had sessions in
  worktrees, the worktree folders go with the project's data, but your repository may still list them: run `git worktree prune`
  there **(not verified whether Octo does this itself)**.
- **A secret or the API key:** Settings → Providers → API key → **Remove key**. The key is removed from `harness.env`.
- **A paired phone:** Settings → Remote access → **Remove**.
- **The router's history:** quit Octo and delete `router/history.sqlite` (and its `.key`).
- **Everything:** quit Octo and delete `<app data>`. Uninstalling the app does not do it.

A project folder you delete or move on disk is shown as "missing"; remove it from the project, or put it back.
