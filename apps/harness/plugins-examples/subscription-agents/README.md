# subscription-agents

Claude Code, GitHub Copilot, Grok, Codex, Cursor, OpenCode, Antigravity, Devin, Factory Droid, Oh My Pi and Pi as ACP sub-agents. Each runs on the subscription its own CLI is logged in to; the harness never reads the CLIs' credential files.

This plugin is **built into the harness binary** (`embed.go` embeds `plugin.json`; there is no copy), so plain `harness serve` has it, no key needed:

```bash
go run ./cmd/harness serve
curl localhost:8790/v1/plugins    # builtin: true; available, logged_in (null without a probe), models, hint
```

To change it, copy this directory into `{data-dir}/plugins/` (or pass it with `--plugins-dir`): a plugin of the same name replaces the built-in one. `--no-builtin-plugins` / `HARNESS_NO_BUILTIN_PLUGINS=1` turns it off.

**Only the scripted fake agent has been run against this harness.** Copilot, Grok and Codex follow vendor docs; the other entries come from vendor docs, the ACP registry and secondary sources and are unverified (binary names, flags, probe exit codes, auth method ids).

The harness passes these processes only an allow-list of its environment (see "Child environment" in the harness `README.md`; `HARNESS_CHILD_ENV_ALLOW` adds names) and always hides its own `ANTHROPIC_*`, `OPENAI_*`, `XAI_*`, `GEMINI_*` ... variables so a subscription is not pushed onto per-token billing; an entry's `env` (for example `"XAI_API_KEY": "${XAI_API_KEY}"`) passes a variable on purpose. The commands, logins and env vars per agent are tabulated in the harness `README.md`, "Running on subscriptions" (with the scrub rules); `auth.methods` / `auth.skip` and the `{modelArgs}` placeholder are described in `../README.md`.

**`flatRate` per entry** (used by automatic routing, `tier: auto`): `true` for claude-code, codex, copilot, cursor, antigravity and devin (the CLI's own subscription or plan is what is used; a key such as `CURSOR_API_KEY`, `WINDSURF_API_KEY` or `COPILOT_GITHUB_TOKEN` only authenticates that plan); `false` for grok (its entry forwards `XAI_API_KEY`, billed per token), droid (token-metered plan with `FACTORY_API_KEY`), and opencode, omp and pi (they front arbitrary model providers whose billing is unknown). The choice is a judgement, not data: override it by copying the plugin (see above) and editing `flatRate`. `strengths` is not set on any entry.
