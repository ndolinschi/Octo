# Settings

The settings screen of the desktop app edits `{data-dir}/harness.env` through two endpoints of the bridge. This page is the contract: the setting ids, what each one does, how a value is stored, what applies at once, and the rules that keep keys safe. The file format and its loading rules are in the [README](../README.md#running-without-a-key-and-harnessenv).

## Settings

The **id** of a setting is the variable name in `harness.env`, so the file stays readable and writable by hand.

| Id | Kind | Group | Applies | Meaning |
| --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | secret | keys | restart | Key the built-in loop sends (Anthropic, or the bearer token an OpenAI/OpenRouter-style router expects). When the shell starts the bundled router it passes the router's upstream key here, see below. |
| `OCTO_ROUTER_UPSTREAM_KEY` | secret | router | restart | The provider key behind the Octo router (OpenRouter, for example). **Read by the desktop shell, not by the harness.** |
| `HARNESS_MODEL_ORCHESTRATOR` | model | models | now | Default orchestrator: a model id or `acp:<agent-id>[/<model>]`. Built-in default `claude-sonnet-5-5`. |
| `HARNESS_MODEL_FAST` | model | models | now | Fast tier. Default `claude-haiku-5-5`. |
| `HARNESS_MODEL_BALANCED` | model | models | now | Balanced tier. Default `claude-sonnet-5-5`. |
| `HARNESS_MODEL_DEEP` | model | models | now | Deep tier. Default `claude-opus-5-5`. |
| `OCTO_ROUTER_ENABLED` | bool | router | restart | `1` / `0`: the shell starts the bundled router and points the harness at it. **Read by the shell.** Default off. |
| `OCTO_ROUTER_BASE_URL` | text | router | restart | Base URL of an **external** router. Empty or unset means the router bundled with the app. **Read by the shell.** |
| `HARNESS_ACP_TRACE` | bool | advanced | now | Record an ACP wire trace: one JSON-lines file per agent session under `{data-dir}/traces/`, secrets removed, capped (see [acp-orchestrator.md](./acp-orchestrator.md#diagnostics-and-the-wire-trace)). Takes effect for sessions that start afterwards. |
| `HARNESS_CHILD_ENV_ALLOW` | list | advanced | now | Extra variable names / `PREFIX_*` patterns passed to every child process (see README "Child environment"). Stored comma separated. |

The harness stores and reports the three `OCTO_ROUTER_*` settings and otherwise ignores them. They are never passed to child processes (`OCTO_ROUTER_` is on the child-environment deny list, which even `HARNESS_CHILD_ENV_ALLOW` cannot override).

### What the shell does with the router settings

The router does not read an upstream key from its own configuration: it forwards the credential its client sends (`Authorization` / `x-api-key`), and `client_auth_key` in its `server.toml` is the key clients present as `x-octo-key`. So when `OCTO_ROUTER_ENABLED=1` and `OCTO_ROUTER_UPSTREAM_KEY` is set, the shell starts the router on a free loopback port with a generated client key and starts the harness with

- `--base-url http://127.0.0.1:<port>/autoroute`
- `ANTHROPIC_API_KEY=<value of OCTO_ROUTER_UPSTREAM_KEY>` in its environment (the harness sends it as the bearer token)
- `HARNESS_OCTO_KEY=<the generated client key>` (or `--octo-key`)

With `OCTO_ROUTER_BASE_URL` set, no router is started: the shell passes that URL as `--base-url` and uses the user's own `ANTHROPIC_API_KEY` / `HARNESS_OCTO_KEY`. Router off, or on without an upstream key: the harness alone. Because those values are given to the harness in its process environment, they win over the file and `GET /v1/settings` shows `ANTHROPIC_API_KEY` as `source: "environment"`, `editable: false` in that situation. The user's own `ANTHROPIC_API_KEY` line in `harness.env` is therefore only effective when the shell is not substituting the router's key.

## `GET /v1/settings`

```json
{
  "settings": [
    { "id": "ANTHROPIC_API_KEY", "kind": "secret", "label": "Anthropic API key", "group": "keys",
      "set": true, "hint": "…wxyz", "source": "file", "applies": "restart", "editable": true },
    { "id": "HARNESS_MODEL_FAST", "kind": "model", "label": "Fast tier model", "group": "models",
      "value": "claude-haiku-5-5", "set": false, "source": "default", "applies": "now", "editable": true },
    { "id": "OCTO_ROUTER_ENABLED", "kind": "bool", "label": "Use the Octo router", "group": "router",
      "value": false, "set": false, "hint": "Read by the desktop app, which starts the router; the harness only stores it.",
      "source": "default", "applies": "restart", "editable": true }
  ],
  "restart_required": ["ANTHROPIC_API_KEY"]
}
```

- `value` is a string (`text`, `model`), a boolean (`bool`) or a string list (`list`). It is **absent for secrets**, and for a `text` setting that is not set. An unset `model` shows the built-in default with `source: "default"`; an unset `bool` is `false`; an unset `list` is `[]`.
- `set` says a value exists in the file or the environment. A secret is never returned: only `set` and, when the secret has at least 16 characters, `hint` = `…` plus its last four characters. For other kinds `hint` is a one-line help text.
- `source`: `file` (a line in `harness.env`), `environment` (the process environment; the file cannot override it, `editable` is `false`, an environment variable that is set but empty counts), `flag` (reserved for a command-line flag; no current setting has one), `default`.
- `restart_required` lists the `applies: "restart"` settings whose value in the file differs from the value this process started with. Writing the original value back removes it from the list. A file that was group-readable at start (and so ignored by the loader) shows its values as pending.
- `note` (optional) says why a setting is locked when that is not obvious: `ANTHROPIC_API_KEY` carries "set by the app while the bundled router is on" when it comes from the environment and `OCTO_ROUTER_ENABLED=1` is in the file.
- A line that cannot be read as its kind (for example `OCTO_ROUTER_ENABLED=maybe`) is ignored and shown as `source: "default"` with an explanatory `hint`.

## `PUT /v1/settings`

Body: `{ "set": { "<id>": value }, "unset": ["<id>"] }`, at least one of them. Response: the same document as `GET`. The whole request is validated first; **nothing is written unless everything is valid.**

| Rule | Status / code |
| --- | --- |
| unknown id, or a body that is not that object (unknown field, bad JSON) | 400 `unknown_setting` / `invalid_request` |
| the id is set in the process environment | 400 `setting_locked` |
| the same id in `set` and `unset` | 400 `invalid_request` |
| wrong type (a bool must be a JSON boolean, a list a JSON array of strings), bad value | 400 `invalid_value` |
| not loopback (see Security) | 403 `forbidden` |

Value rules:

- Every stored value is trimmed, must not contain control characters or line breaks and must not start with a quote.
- **secret**: non-empty, at most 512 characters.
- **model**: non-empty, at most 200 characters, `[A-Za-z0-9][A-Za-z0-9._:/@+-]*`. An `acp:<id>[/<model>]` value is validated like a project model: the agent must be loaded and available, and the model one the manifest allows (the tiers may be `acp:` too).
- **text**: at most 2048 characters; `OCTO_ROUTER_BASE_URL` must be an `http(s)` URL with a host and no credentials, query or fragment. `""` removes the setting.
- **bool**: stored as `1` / `0`.
- **list**: names (`[A-Za-z_][A-Za-z0-9_]*`) or `PREFIX_*` patterns, at most 100; blanks are dropped; `[]` removes the setting.

Writing is atomic: a temporary file in the data directory with mode `0600`, synced and renamed over `harness.env`, so a reader sees the old file or the new one. Comments, blank lines and variables the settings screen does not know are kept exactly; a changed key is replaced in place (later duplicates of it are dropped), a new key is appended, `unset` removes the line. A file that was group-readable comes out `0600`. The data directory is created (`0700`) when missing.

### Applying

| Applies | How |
| --- | --- |
| `now` (models, orchestrator, allow list) | Swapped in the running process under a lock: new projects get the new default models (`GET /v1/config` `default_models`), turns that start afterwards resolve the new default orchestrator (and the no-key choice of an ACP agent, see README), child processes started afterwards get the new allow list. Running turns and running children are not touched. |
| `restart` (keys, router settings) | Written only. Listed in `restart_required` until the harness has been restarted. The desktop shell restarts its sidecars (`bridge_restart`). |

Existing projects keep the models stored when they were created; a project that used the old default orchestrator now counts as having chosen it explicitly. Change a project's own models in its settings.

If a file written earlier names an `acp:` agent that is no longer available, `harness serve` logs a warning and starts with the built-in models instead of refusing to start, so the setting can be corrected from the app.

## Event `settings.changed`

The bridge has no global event stream, only one per project (`GET /v1/projects/{pid}/events`). After a `PUT` that changed something, the harness publishes `{ "type": "settings.changed", "seq": n, "ids": ["HARNESS_MODEL_FAST"] }` on **every** project stream (each with that stream's own `seq`). Only ids, never values; nothing is published for a request that changed nothing. On receipt a client refetches `GET /v1/settings` and `GET /v1/config`.

## Bridge API token

`HARNESS_API_TOKEN` and `HARNESS_NO_API_TOKEN` are not settings: they are read from the process environment only (the settings screen neither shows nor sets them). The settings routes are `/v1` routes like the rest and need the token. Details: the harness README, "Bridge API token".

## Security

- **Loopback only.** The endpoints answer 403 `forbidden` when the bridge listens on a non-loopback address (`--addr 0.0.0.0:…`, `:8790`, a LAN IP), when the peer is not a loopback address, when the `Host` header is not `localhost`, `127.0.0.0/8` or `::1` (DNS rebinding), and when the request has an `Origin` the bridge does not allow (the same rule as CORS: `http(s)://localhost|127.0.0.1[:port]`, `tauri://localhost`, `http://tauri.localhost`; `Origin: null` is refused). Unlike the other routes, which merely withhold the CORS headers, a refused origin is rejected outright, because this endpoint writes keys.
- **Write-only secrets.** A secret value is never in a response, a log line, an error message, an event or the `hint` (which is withheld below 16 characters). Error texts name the setting and the rule, never the value; a JSON syntax error answers with a fixed message because the decoder would quote a byte of the body.
- **File mode `0600`** on every write.
- The process environment cannot be changed from here: such settings are `editable: false`.
