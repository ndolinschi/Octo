import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeConfig, Plugin, ProviderList, SettingsView } from "@octo/agent-client";
import { deriveProviders } from "./derive";
import { API_PROVIDER, ROUTER_PROVIDER, canRun, chipLabel, connectAction, extraReason, providerOf, stateText } from "./providers";

const config = (over: Partial<BridgeConfig> = {}): BridgeConfig => ({
  default_models: { orchestrator: "claude-sonnet-5-5", fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5" },
  default_max_depth: 3,
  ...over,
});

const plugins: Plugin[] = [
  {
    name: "agents",
    version: "1",
    description: "",
    language_servers: [],
    tool_servers: [],
    errors: [],
    agents: [
      {
        id: "claude-code",
        label: "Claude Code",
        available: true,
        logged_in: true,
        models: ["claude-opus-5-5", "claude-sonnet-5-5"],
        default_model: "claude-sonnet-5-5",
      },
      { id: "copilot", label: "GitHub Copilot", available: true, logged_in: false, hint: "Run `copilot` and type /login." },
      { id: "grok", label: "Grok", available: false, unavailable_reason: "grok: command not found", install_hint: "npm install -g grok" },
    ],
  },
  // A second plugin listing the same agent does not duplicate it.
  {
    name: "dup",
    version: "1",
    description: "",
    language_servers: [],
    tool_servers: [],
    errors: [],
    agents: [{ id: "copilot", label: "Copilot again", available: true }],
  },
];

const settings = (keySet: boolean, router = false): SettingsView => ({
  restart_required: [],
  settings: [
    { id: "ANTHROPIC_API_KEY", kind: "secret", label: "Anthropic API key", group: "keys", set: keySet, source: "file", applies: "restart", editable: true },
    {
      id: "OCTO_ROUTER_ENABLED",
      kind: "bool",
      label: "Use the Octo router",
      group: "router",
      value: router,
      source: "file",
      applies: "restart",
      editable: true,
    },
  ],
});

test("deriveProviders: api, router, then each agent once with its state and hints", () => {
  const list = deriveProviders({ config: config({ builtin_loop: { available: false, reason: "no key" } }), plugins, settings: settings(false) });
  assert.deepEqual(
    list.providers.map((p) => [p.id, p.kind, p.state]),
    [
      [API_PROVIDER, "api", "not_connected"],
      [ROUTER_PROVIDER, "router", "not_connected"],
      ["claude-code", "agent", "ready"],
      ["copilot", "agent", "not_logged_in"],
      ["grok", "agent", "not_installed"],
    ],
  );
  assert.equal(list.connected, 1);
  const grok = list.providers.find((p) => p.id === "grok");
  assert.equal(grok?.install_hint, "npm install -g grok");
  assert.equal(grok?.reason, "grok: command not found");
  assert.equal(list.providers.find((p) => p.id === "copilot")?.login_hint, "Run `copilot` and type /login.");
  // Decision 53 c: one agent connected → it runs everything.
  assert.deepEqual(list.suggested, { orchestrator: "acp:claude-code", fast: "acp:claude-code", balanced: "acp:claude-code", deep: "acp:claude-code" });
  // The agent's default model is listed with the others, once.
  assert.deepEqual(
    list.providers.find((p) => p.id === "claude-code")?.models.map((m) => m.label),
    ["Sonnet 5.5", "Opus 5.5"],
  );
});

test("deriveProviders: a key makes the API ready with the default tiers; unknown reads as connected", () => {
  const withKey = deriveProviders({ config: config(), plugins: [], settings: settings(true) });
  assert.equal(withKey.providers[0]?.state, "ready");
  assert.deepEqual(
    withKey.providers[0]?.models.map((m) => m.id),
    ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  );
  assert.equal(withKey.suggested.orchestrator, "claude-sonnet-5-5");
  // An old harness without builtin_loop and without settings: never locked out.
  assert.equal(deriveProviders({ config: config(), plugins: [] }).connected, 1);
  // Router switched on but not seen by the harness: an error with a reason.
  const router = deriveProviders({ config: config(), plugins: [], settings: settings(false, true) }).providers[1];
  assert.equal(router?.state, "error");
  assert.ok(router?.reason);
  assert.equal(deriveProviders({ config: config({ router: true }), plugins: [] }).providers[1]?.state, "ready");
});

test("stateText and connectAction", () => {
  assert.equal(stateText("not_logged_in"), "Not logged in");
  assert.equal(connectAction({ state: "ready", kind: "api" }), "Manage");
  assert.equal(connectAction({ state: "not_connected", kind: "api" }), "Connect");
  assert.equal(connectAction({ state: "not_logged_in", kind: "agent" }), "How to connect");
  assert.equal(connectAction({ state: "not_installed", kind: "agent" }), "How to connect");
  assert.equal(connectAction({ state: "error", kind: "router" }), "Reconnect");
});

const list: ProviderList = deriveProviders({ config: config(), plugins, settings: settings(true) });

test("chipLabel names agent models as 'Agent · Model'", () => {
  assert.equal(chipLabel("acp:claude-code/claude-opus-5-5", list), "Claude Code · Opus 5.5");
  assert.equal(chipLabel("acp:claude-code", list), "Claude Code");
  assert.equal(chipLabel("claude-haiku-5-5", list), "Haiku 5.5");
  assert.equal(chipLabel("openai/gpt-x", list), "gpt-x");
  assert.equal(chipLabel("acp:claude-code/claude-opus-5-5", null), "claude-code · Opus 5.5");
});

test("canRun: only what a ready provider runs", () => {
  assert.equal(canRun(list, "acp:claude-code/claude-opus-5-5"), true);
  assert.equal(canRun(list, "acp:claude-code/nope"), false);
  assert.equal(canRun(list, "acp:copilot"), false);
  assert.equal(canRun(list, "claude-sonnet-5-5"), true);
  assert.equal(canRun(list, ""), false);
  const agentsOnly = deriveProviders({ config: config(), plugins, settings: settings(false) });
  assert.equal(canRun(agentsOnly, "claude-sonnet-5-5"), false);
  assert.equal(canRun(agentsOnly, "acp:claude-code"), true);
});

test("providerOf: the provider a setting runs on", () => {
  assert.equal(providerOf(list, "acp:claude-code/claude-opus-5-5")?.id, "claude-code");
  assert.equal(providerOf(list, "claude-sonnet-5-5")?.id, API_PROVIDER);
});

test("extraReason drops a reason that only repeats the state", () => {
  assert.equal(extraReason({ state: "not_logged_in", reason: "not logged in" }), "");
  assert.equal(extraReason({ state: "not_installed", reason: "grok: command not found on PATH" }), "grok: command not found on PATH");
  assert.equal(extraReason({ state: "ready", reason: "" }), "");
});
