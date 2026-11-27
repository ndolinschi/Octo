# First run

## Starting

The first window shows "Starting Octo…" while the app starts its local service. If that fails, the window shows the reason,
the last 20 lines of the service's log, and a Retry button. If it keeps failing, see [Troubleshooting](troubleshooting.md).

Then, if nothing is connected yet, you see **Connect a provider to start.** with the line "Octo needs one of these: a coding
agent on this computer, an API key, or the Octo router." Octo cannot run a project until one of them is ready.

## What a provider is

A _provider_ is anything that can run a model for you. The list on the connect screen is the same list as
**Settings → Providers**, grouped as **Connected**, **Needs attention** and **Not set up**.

| Provider | What it is | How you pay |
| --- | --- | --- |
| Anthropic API | Octo's own agent loop, calling a model with your API key | Per token, billed to your key |
| Octo router | An optional proxy inside the app that picks cheaper models for easy work and keeps a budget; it needs one provider key, such as OpenRouter's | Per token, through that key |
| Agents (Claude Code, GitHub Copilot, Grok, Codex, Cursor, OpenCode, Antigravity, Gemini CLI, Devin, Factory Droid, Oh My Pi, Pi) | Programs on your computer that Octo drives for you | Your subscription with that vendor, no charge per token |
| Ollama | A local model server, used only for the small inline-completion model in the editor | Free, local |

**Ollama alone does not let you start a project.** Projects need an agent, an API key or the router.

## Add an API key

1. Choose **Anthropic API** in the list, then enter the key in **API key** and press **Connect**.
2. The key applies at once, with no restart. **Replace key** and **Remove key** appear once it is set.

The key is kept in a file in your data folder that only you can read ([Privacy and data](privacy-and-data.md)). It is sent to
the model provider and nowhere else. A key found in the process environment (for example set when Octo starts the router) is
shown but cannot be edited here.

## Add an agent

Octo does not install agents. For the agent you want:

1. Install it and log in **once in a terminal**, the way the vendor says. Octo shows the exact commands in the agent's detail
   pane, with a copy button: for example `claude auth login`, `copilot login`, `grok login`, `codex login`, `agy acp --login`.
2. Press **Check again** in Octo. A logged-in agent turns **Ready**. You do not need to restart Octo.
3. Choose the agent as the project's main agent or from the model menu in a session ([Working with an agent](working-with-an-agent.md)).

For Claude Code, Codex, Devin and Gemini CLI you can also log in from Octo and keep more than one account: see
[More than one account of an agent](#more-than-one-account-of-an-agent).

Octo gives an agent the same environment your terminal has (your `PATH`, `HOME`, proxy settings and a few more), so an agent
that works in your terminal finds its login. It does not pass your provider keys on to an agent, with one exception: a few
agents name a vendor key in their entry (for example `XAI_API_KEY` for Grok), and if that key is in Octo's environment it is
forwarded to that agent only, which switches the agent from your subscription to per-token billing. The agent's detail pane
warns about these.

**Verification.** Claude Code has been run with Octo for real. Copilot and Grok were tried logged out only. The other agents were
written from the vendors' documentation and the ACP agent registry and never run: they are marked **experimental** in the list.
Octo adds a model list to each agent by opening a short, empty session with it (no prompt is sent, so nothing is billed).

## More than one account of an agent

Some agents can be logged in to a second account (a work and a personal Claude Code, say). Octo runs the agent with a separate
login folder for each account and lists them side by side, such as **Claude Code · Personal** and **Claude Code · Work**.

**Which agents.** Claude Code, Codex, Devin and Gemini CLI (experimental) can have several accounts. **One account only:**
Antigravity (its app, command line and editor share one system login), Copilot (the CLI has its own `/user switch`; run it
inside Copilot), Cursor, Grok and OpenCode (Octo has not confirmed where they keep the login), Droid (it signs in with an API key,
and Octo does not store keys), and omp and pi (not looked into). The agent's detail pane says "One account only" and why.

**Add an account.** Settings → Providers → the agent → **Accounts** → **Add account**. Give it a name (up to 40 characters). The
first time, you can also name your current login, which Octo calls "Default" until you rename it. Octo makes a folder for the new
account inside its data folder. **Use an existing folder** is for an agent that already has a login in a folder you chose (for
example `~/.claude-work`); Octo uses it as it is and never deletes it. The short id Octo gives the account (`work`) is fixed; the
name can change.

**Log in.** Press **Log in** on the account's row (a small menu if the agent has several ways, such as Claude's subscription or
Console). Octo runs the agent's own login command in a terminal inside Octo, with that account's folder, and shows what the
command prints: a link, a code, a prompt to paste a code. Press **Open in browser** or **Copy link**, follow the steps, and type
into the terminal if it asks. Octo checks the login every few seconds and when the command ends; the row turns **Ready**. The
command is also shown under the terminal, so you can run it in a terminal of your own and press **Check again**. If the button
fails, use that command.

**A browser already signed in to the other account will complete the wrong login.** Before you open the link, sign out of the
other account in that browser, or copy the link into a private window.

**Rename and remove.** **Rename** changes the name only. **Remove** takes the account out of Octo's lists; projects that used it
show the model as unavailable until you pick another. The box **Also delete its login folder** appears only for a folder Octo made,
and is off by default: it deletes that folder, which signs the account out for good. It does not remove an entry the agent may
have saved in your system keychain; remove that yourself if you want it gone. A folder you chose is never deleted. The default
account (your first login) cannot be removed.

**Choose an account.** In the model menu each account is its own entry (**Claude Code · Work**), and its models are inside it.
A project uses the account its models name. **Octo never uses another account by itself:** when a project names none, only the
first (default) account is offered to delegate work to, so a work login is not billed for personal projects.

**When a limit is reached.** If an agent says the account's usage limit is reached, the request stops with "<Agent> · <Account>
has reached its usage limit." and two buttons: **Use another account** (the agent's other accounts, with their state) and
**Choose another model**. Pick one and Octo sends your request again. Nothing switches without you. A different account starts a
new session with the agent, which gets a short summary of the conversation so far (at most 8000 characters), not the old
session itself. The account that ran out shows "limit reached" in the list until it works again or the reset time passes; **Check
again** clears it too. Octo can only react to a limit the agent reports as an error. A limit written into the agent's reply text
is not noticed.

**Only on this computer.** Adding, renaming, removing, logging in and switching accounts are not available from a paired phone
([Remote access](remote-access.md)). When a limit stops a request on a phone, it says "Change this on your computer" and offers the plain Retry.

**Where the logins live.** Octo stores only the names, short ids and folders. The agent itself writes its login into the
account's folder inside Octo's data folder, and Octo never reads it ([Privacy and data](privacy-and-data.md#agent-accounts)).

**Verification.** Accounts were checked only with a stand-in agent, scripted login commands and Octo's tests. **Not verified with
any real agent or account:** that two Claude Code logins stay apart in the macOS keychain per folder, each agent's login inside
Octo's terminal, the real limit messages and where they arrive, the reset-time format, Gemini's login storage and Devin's
folder move. If something differs, run `harness doctor` (it lists each account with its folder and login check) and
[tell the owner](troubleshooting.md#reporting-a-problem).

## What the states mean

| Shown | What it means | What to do |
| --- | --- | --- |
| **Ready** (with "N models") | Octo can use it now. For an agent: the command was found and nothing says it is logged out | Nothing |
| **Not logged in** | The agent is installed, but its login check says you are logged out | Log in once in a terminal with the command shown, then **Check again**. If the agent has no login check, Octo shows it as Ready and the first request fails with the agent's own "not logged in" message; log in and send again |
| **Not installed** | The agent's command is not on this computer, or it is too old ("needs 1.5.0 or newer") | Install or update it with the line shown, then **Check again** |
| **Not running** | Ollama, or a model server on a local address, does not answer at its URL | Start it (the pane shows the command, for Ollama `ollama serve`), then **Check again**. A remote server that "does not answer": check the server and its URL |
| **Not connected** | The Anthropic API has no key, or the router is off | Add the key, or turn the router on and add its provider key |
| **Not supported** | Octo cannot use this agent | Nothing to do; the pane says why |
| **Not working** | Something failed that Octo cannot name | **Check again**, or copy the diagnostic report from Settings → Privacy and data and look at [Troubleshooting](troubleshooting.md) |

"Not logged in" is a guess made by a check that ran earlier; the agent's own session is the truth. Before Octo refuses a request
because of it, Octo re-runs the check, so a login you just did is noticed.

## Then create a project

From Home or the sidebar choose **New project**, pick a folder (Recent, a typed path, or **Browse…** for the system's folder
dialog), and create it. A project never needs a login to be created; if its agent is not ready the project says so calmly and
tells you the next step. See [Projects and sessions](projects-and-sessions.md).
