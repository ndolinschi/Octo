# subscription-agents

Claude Code, GitHub Copilot, Grok, Codex, Cursor, OpenCode, Antigravity, Devin, Factory Droid, Oh My Pi and Pi as ACP sub-agents. Each runs on the subscription its own CLI is logged in to; the harness never reads the CLIs' credential files.

```bash
go run ./cmd/harness serve --plugins-dir plugins-examples/subscription-agents
curl localhost:8790/v1/plugins    # available, logged_in (null without a probe), models, hint
```

**Only the scripted fake agent has been run against this harness.** Copilot, Grok and Codex follow vendor docs; the other entries come from vendor docs, the ACP registry and secondary sources and are unverified (binary names, flags, probe exit codes, auth method ids).

The harness passes these processes only an allow-list of its environment (see "Child environment" in the harness `README.md`; `HARNESS_CHILD_ENV_ALLOW` adds names) and always hides its own `ANTHROPIC_*`, `OPENAI_*`, `XAI_*`, `GEMINI_*` ... variables so a subscription is not pushed onto per-token billing; an entry's `env` (for example `"XAI_API_KEY": "${XAI_API_KEY}"`) passes a variable on purpose. The commands, logins and env vars per agent are tabulated in the harness `README.md`, "Running on subscriptions" (with the scrub rules); `auth.methods` / `auth.skip` and the `{modelArgs}` placeholder are described in `../README.md`.
