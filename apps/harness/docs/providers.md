# Providers

A *provider* is anything that can run a model: the built-in Messages-API loop (an API key or a gateway), a detected Octo router, or an ACP agent CLI on this machine. `GET /v1/providers` says which are ready, what each offers and how to make the others ready, so a client can connect first and choose second (UI decisions 53 and 58). Nothing in this feature runs a provider or an agent: states come from configuration, the plugin registry (command found, background login probe) and a cache of the models agents advertised.

## `GET /v1/providers`

```json
{
  "connected": 2,
  "suggested": { "orchestrator": "claude-sonnet-5-5", "fast": "claude-haiku-5-5", "balanced": "claude-sonnet-5-5", "deep": "claude-opus-5-5" },
  "providers": [
    { "id": "api", "kind": "api", "label": "Anthropic API", "state": "ready", "reason": "",
      "install_hint": "", "login_hint": "Add an API key in Settings (ANTHROPIC_API_KEY).",
      "models": [{ "id": "claude-opus-5-5", "label": "Claude Opus 5.5", "source": "catalogue" }],
      "default_model": "claude-sonnet-5-5", "flat_rate": false },
    { "id": "claude-code", "kind": "agent", "label": "Claude Code", "state": "not_logged_in", "reason": "not logged in",
      "install_hint": "", "login_hint": "Run `claude` once.",
      "models": [{ "id": "opus", "label": "opus", "source": "manifest", "seen_at": "2026-11-11T12:00:00Z", "stale": true }],
      "default_model": "opus", "flat_rate": true }
  ]
}
```

Order: `api`, then `router` (only while an Octo router is detected), then one entry per ACP agent in manifest order with `claude-code`, `copilot`, `grok` first.

| Entry | `ready` when | Models |
| --- | --- | --- |
| `api` | the built-in loop can run (a key, an Octo key, or a base URL other than the Anthropic API) and no router is detected. With a router detected it is `not_connected` ("runs through the Octo router") | `catalogue`: the three compiled-in tiers plus any non-ACP default model |
| `router` | an Octo router answered its health check | the same catalogue |
| agent | the command is found and its login probe has not said "logged out". An agent with a probe and no result yet counts as ready (the event below announces the result) | manifest `models` followed by the models it advertised |

States: `ready`, `not_connected` (API, router), `not_logged_in` (`login_hint` = manifest `auth.hint`), `not_installed` (`install_hint` = manifest `install`, `reason` = what is missing), `error` (reserved, never produced yet). `connected` counts `ready` entries. `flat_rate` is the manifest's `flatRate`.

### Agent models

`models` is the manifest list plus every model the agent advertised in a session the harness opened (`source: "advertised"` when only advertised, else `"manifest"`). `seen_at` is when a session last advertised it. `stale: true` flags a model the agent's **latest** session did not advertise; it is kept, never dropped. `default_model` is the manifest's `defaultModel`, else the model the agent reported as current. Choosing one stores `acp:<agent>/<model>`; the manifest-or-advertised union is also what project validation accepts (only for an agent whose manifest lists models; one that lists none accepts any id).

The cache is `{data-dir}/agent-models.json` (mode `0600`, no schema change, ids validated on read, a corrupt file is ignored). It is written when the set of models changes, and at most every 10 minutes otherwise.

**Wiring.** The ACP session code reports what an agent advertised through `acp.RunOptions.OnModels`, which `Orchestrator` keeps (`AdvertisedModels(agentID)`) and announces (`OnAdvertisedModels(fn)`, only when the list changed). `harness serve` registers a callback that copies each report into the providers service (`Service.Record`), which merges it with earlier ones and persists it.

### `suggested`

What a project created without models gets: the current defaults (`HARNESS_MODEL_*`) when the API or router is ready (a default naming an agent that is not ready falls back to the compiled-in model of its slot); otherwise the first ready agent in the order `claude-code`, `codex`, `copilot`, then the rest, as `acp:<id>` in all four slots; empty strings when nothing is ready.

## Event `providers.updated`

`{ "type": "providers.updated", "seq": n, "connected": 2 }` on every project stream (like `settings.changed`). Sent only when the picture changed (seen_at aside): a login probe changed its outcome, a key or default model was written, an agent advertised new models, the router appeared or went away (re-read every 15 s). A client refetches `GET /v1/providers`. State: `providersRevision` in `@octo/agent-client`.

## Model checks

- `POST /v1/projects` with nothing ready: `409 no_provider`.
- `POST`/`PATCH /v1/projects` naming a model whose provider is not ready: `422 model_unavailable`, `{"error": {"code", "message", "provider", "reason"}}` (`reason` is a sentence with the hint). On PATCH only models that differ from the stored ones are checked, so a client may send the whole object back. Unknown agents or models stay `400 invalid_request`, checked first.
- A new project's four models come from `suggested`, overlaid by what the request names.
- Reading never fails: `GET /v1/projects/{id}` lists unusable stored models in `models_unavailable: [{field, model, provider, reason}]` (always an array). A project whose orchestrator equals the server default while the built-in loop is off still runs on a ready agent (`EffectiveOrchestrator`); it is listed anyway.

## Connecting a key without a restart

`PUT /v1/settings` with `ANTHROPIC_API_KEY` applies at once (`applies: "now"`, not in `restart_required`): the Messages client and the router's route call read the key per request (`config.KeySource`), and the orchestrator's built-in-loop switch is swapped (`SetBuiltinUnavailable`), so `GET /v1/config` `builtin_loop`, `/v1/providers` and the next turn see it. Removing the key turns the loop off again. A key from the process environment (for example set by the desktop app for the bundled router) stays `editable: false`. `restart_required` still lists the router settings the desktop shell reads. A process that cannot swap its key (no `Applier.APIKey`, i.e. an embedder) keeps `applies: "restart"`.

## Failed turns and retry

- The orchestrator row keeps the turn's error (`agent.error`) and is `idle`; the project JSON has `attention`: `"needs_you"` (approval or form waiting), `"failed"` (last turn failed, nothing waiting), `"none"`. `project.attention` events carry `state: "failed"` and `error` when a turn fails and `state: "none"` when a retry starts.
- The UI's Retry posts the same text to `POST /v1/projects/{id}/messages`. If the orchestrator's last turn failed and its newest stored message is that very user message (nothing answered), the stored message is reused: no second user row, no `message.created`, the response carries the existing message, the open task record of the failed attempt continues. Otherwise the text is an ordinary new message. Every turn ends with `turn.finished` (`completed`, `failed` with the error, or `cancelled`).

## Not verified

No real agent CLI was run. Probe results, advertised models and logins were exercised with the scripted agent (`internal/fakeacp`) and fake probe commands.
