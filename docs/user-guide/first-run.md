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
| Agents (Claude Code, GitHub Copilot, Grok, Codex, Cursor, OpenCode, Antigravity, Devin, Factory Droid, Oh My Pi, Pi) | Programs on your computer that Octo drives for you | Your subscription with that vendor, no charge per token |
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

Octo gives an agent the same environment your terminal has (your `PATH`, `HOME`, proxy settings and a few more), so an agent
that works in your terminal finds its login. It does not pass your provider keys on to an agent, with one exception: a few
agents name a vendor key in their entry (for example `XAI_API_KEY` for Grok), and if that key is in Octo's environment it is
forwarded to that agent only, which switches the agent from your subscription to per-token billing. The agent's detail pane
warns about these.

**Verification.** Claude Code has been run with Octo for real. Copilot and Grok were tried logged out only. The other agents were
written from the vendors' documentation and the ACP agent registry and never run: they are marked **experimental** in the list.
Octo adds a model list to each agent by opening a short, empty session with it (no prompt is sent, so nothing is billed).

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
