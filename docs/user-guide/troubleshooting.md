# Troubleshooting

Octo writes errors for people: one plain sentence, one next step, and a **Details** fold with the technical text. Read the
sentence and the step first. This page lists the common ones.

## First, find out what Octo sees

- **In the app:** Settings → Privacy and data → **Copy diagnostic report** ([what is in it](privacy-and-data.md#copy-a-diagnostic-report)).
- **`harness doctor`** prints the same report in a terminal: versions, the data folder, the `PATH` your agents get, the names
  (never values) of provider variables that are set, whether the built-in loop and the router are available, and for each agent
  its command (or "not found"), its login check and the install and login hints. The app bundles the harness; from a clone of the
  source run

  ```bash
  cd apps/harness
  go run ./cmd/harness doctor              # add --json for a machine-readable report
  go run ./cmd/harness doctor --show-probe-output   # also the first lines each agent's login check printed
  go run ./cmd/harness doctor --data-dir "<app data>/harness"
  ```

  Without `--data-dir`, `doctor` uses the desktop app's data folder when it exists. It runs each login check once (an exit
  status only; no request goes to a vendor).
- **Logs.** `harness.log` and `router.log` in the app's log folder ([where](privacy-and-data.md#where-your-data-lives)). The last
  200 harness lines are also in the diagnostic report, with credentials removed. Started from a terminal, the harness prints its
  log there.
- **The wire trace.** For an agent that fails in a way you cannot explain, turn on Settings → Privacy and data → **Record what
  agents send and receive**, repeat the failure, and look at the newest file in `harness/traces/`. It contains your prompts: read
  it before sharing.

## Starting Octo

| You see | What to do |
| --- | --- |
| "Starting Octo…" never finishes, or a failure screen with log lines | Press **Retry**. Read the log lines: a missing port, a permission error on the data folder, or "Another Octo service is already using this data folder" (quit the other Octo, or the harness you started in a terminal) |
| "Octo's local service restarted while this request was running." | The request was cut off by a restart. What it had written is kept if it had written anything. **Retry** |
| A quiet line "router failed" with **Details** and **Retry** | The optional router did not start; Octo runs without it. Open Details for the log, check the router's provider key in Settings → Providers |
| "Octo cannot open its list of projects." | The registry file is damaged. Octo left it untouched. Restore it from a backup, or move `harness/registry.sqlite` away to start with an empty list (your project folders are not affected, but the history in Octo's project files is no longer listed) |
| An **offline** screen in a browser | Nothing answers at the bridge address. In the app this should not happen; started by hand, run `harness serve` |

## A project is unavailable

A project can show **unavailable** instead of opening:

- "This project's saved data is damaged, so Octo cannot open it." / "Octo cannot read this project's saved data." Octo did not
  change the file. The message names a backup when one exists (`project.sqlite.pre-m6`, `project.sqlite.pre-v15`, or a numbered
  one). Restore it while Octo is quit, or ask for help with the file untouched.
- "This project was saved by a newer version of Octo." Update Octo to open it. Do not delete the file.
- "The project folder <name> is missing." The folder moved or was deleted. Put it back, or remove it from the project in its
  settings. The history stays.

## Agents and models

| Message | What it means and the fix |
| --- | --- |
| "<Agent> is not logged in." | Log in once in a terminal with the command shown (copy button), then **Check again**. Octo re-checks before refusing |
| "<Agent> is not installed." | Install it with the line shown, then **Check again** |
| "<Agent> <version> is too old for Octo; it needs <min> or newer." | Run its installer again to update, then **Check again** |
| "<Agent> did not start the way Octo asked." | The agent rejected a start option: update it; if it persists, turn on the wire trace and report |
| "<Agent> stopped while starting." / "<Agent> stopped in the middle of the request." / "<Agent> did not answer in time." | **Retry**. Octo starts the agent again by itself |
| "<Agent> stopped before writing an answer." | Send the request again. If it repeats, check the agent in a terminal with a plain prompt |
| "<Agent> could not use Octo's tools this time; the request ran without delegation and notes." | The agent refused Octo's tool server. The request still ran. Update the agent |
| "<Agent> does not offer the model <name>." | The hint lists the models it does offer; choose one, or type another in Settings → Providers |
| "No model provider is connected." / "The built-in agent has no API key." | Add an API key in Settings, or log in to an agent ([First run](first-run.md)) |
| "The provider did not accept the API key." | Re-enter the key in Settings → Providers |
| "The connection to the model broke off." / "The Octo router stopped answering." | Check your network and the provider; for the router, restart Octo (it starts it again) |
| "Ollama is not running." | Run `ollama serve`, then **Check again** |
| "This project's budget is used up ($X of $Y)." | Raise or remove the budget in Project settings. Nothing more is sent until you do |
| "That is too much to send at once (the limit is 1 MiB)." | Save the long text as a file in the project and mention it with `@` |

## Accounts of an agent

| You see | What it means and the fix |
| --- | --- |
| The **Log in** button shows an error, or the login sheet says Octo cannot log in from here | Run the command shown under the sheet in a terminal, then press **Check again**. Octo could not start the agent's login command or the agent has none for Octo to run |
| The login finished but the account stays "Not logged in" | Press **Check again**. If it does not change, run the shown command yourself and read what the agent says. For Gemini CLI Octo has no login check: the state reads unchecked until a request works |
| The account is logged in as the **wrong** person | A browser that is already signed in to the other account completed the login. Run **Log in** again after signing out of the other account in that browser, or open the link in a private window |
| "<Agent> · <Account> has reached its usage limit." | The agent said the plan's limit is reached. Press **Use another account**, or **Choose another model**, or wait for the reset. Nothing switches by itself. If you never see this message but the agent's reply says it is out of usage, Octo did not recognise the limit; choose another account yourself |
| "<Agent> · <Account> is being rate limited." | The agent refused the request for a short-term rate limit (not the plan's limit). Retry in a moment, or choose another account or model; Octo does not mark the account as at its limit |
| "The file agent-accounts.json cannot be read, so accounts cannot change." | The accounts file in Octo's data folder is damaged or written by a newer Octo. Fix it or move it aside (it is never overwritten), then restart Octo |
| "<Agent> can keep one account only." | That agent cannot keep a second login apart ([which ones](first-run.md#more-than-one-account-of-an-agent)); use its one login or another agent |
| "An account with that name exists already." | Names are unique per agent, ignoring case; the first account's name counts too |
| "Change this on your computer" | You are on a paired phone; accounts and the project's model are changed on the computer only |

`harness doctor` lists every account with its folder and runs its login check with its own folder.

If an agent works in your terminal but "is not logged in" in Octo, Octo's agents inherit the environment of your **login shell**. A
macOS app started from the Dock does not have your shell's `PATH` by itself, so Octo asks your login shell for it (3 seconds).
Run `harness doctor`: it lists the variable names the agents get. If the agent's command is "not found", fix your shell's `PATH`.

## Git, worktrees and branches

- "The main checkout has uncommitted changes, so it stays on its branch." / "A session is working in the main checkout…":
  commit or stash your work yourself, wait for the session, or press **Start in a worktree from <branch>**.
- "Git did not switch the branch, so nothing was changed." The Details carry git's own text (an untracked file that would be
  overwritten, a branch already checked out in another worktree).
- "This folder is not in a git repository." The chip needs git. Octo works in folders without git, but without the branch chip,
  worktrees and Review.
- A worktree you no longer need stays in your repository's list: `git worktree list`, then `git worktree remove` or
  `git worktree prune`.

## Review

- Octo says the GitHub CLI is missing or not logged in: install `gh` and run `gh auth login` for the host of the folder's remote.
- Listing says "GitHub did not answer in time, so the request was cancelled.": **Retry**.
- A checkout into your folder lists your dirty files first and is blocked by them; commit or stash, or use the read-only workspace.

## The interface

- **Files made outside Octo are not in the tree.** Octo does not watch the file system; collapse and open the folder again.
- **Sluggish scrolling in a very long conversation.** Known limit: on a slow or throttled computer, scrolling a conversation of
  about a hundred long turns missed its smoothness target in tests. No workaround was verified.
- **Anything that looks wrong in Safari or WebKit:** Octo's interface has not been run in real Safari or in the macOS window since
  the last round of changes. Report it with a screenshot.

## Reporting a problem

Send the person who gave you Octo: what you did, the sentence Octo showed, the Details text, a screenshot, your system, and the
diagnostic report. For an agent that misbehaves also the wire trace (it holds your prompts: read it first) and the output of
`harness doctor --show-probe-output`.
