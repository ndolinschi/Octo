# acp-agents

One more external coding agent over ACP: Gemini CLI (`gemini --acp`). It has not been run from this repository; package names, flags and login steps change, so check the tool's own documentation and the ACP registry before relying on it. The manifest carries an `auth.hint` shown by `GET /v1/plugins` and in the error of a sub-agent that is not logged in, and forwards `GEMINI_API_KEY` (the harness hides all other `GEMINI_*` variables from agents).

Claude Code, Copilot, Grok, Codex and the other subscription CLIs are in `../subscription-agents`. Manifest reference: `../README.md`.
