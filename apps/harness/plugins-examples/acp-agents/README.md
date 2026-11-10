# acp-agents

More external coding agents over ACP: Claude Code (`npx -y @agentclientprotocol/claude-agent-acp`) and Gemini CLI (`gemini --acp`). Neither has been run from this repository; package names, flags and login steps change, so check each tool's own documentation and the ACP registry before relying on them. Each manifest carries an `auth.hint` shown by `GET /v1/plugins` and in the error of a sub-agent that is not logged in.

For Copilot, Grok and Codex see `../subscription-agents`. Manifest reference: `../README.md`.
