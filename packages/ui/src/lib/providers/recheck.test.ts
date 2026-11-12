import assert from "node:assert/strict";
import test from "node:test";
import type { Bridge, Provider, ProviderList } from "@octo/agent-client";
import { BridgeError } from "@octo/agent-client";
import { pickerRows, pickerView } from "./modelList";
import { canUseAnyway, connectAction, stateText } from "./providers";
import { canForce, recheckAgent, refusedProvider } from "./recheck";

const agent = (over: Partial<Provider>): Provider => ({
  id: "grok",
  kind: "agent",
  label: "Grok",
  state: "ready",
  reason: "",
  install_hint: "",
  login_hint: "Run `grok login`.",
  models: [],
  default_model: "",
  flat_rate: true,
  ...over,
});

const list = (...providers: Provider[]): ProviderList => ({
  connected: providers.filter((p) => p.state === "ready").length,
  suggested: { orchestrator: "", fast: "", balanced: "", deep: "" },
  providers,
});

test("only a login the probe says is missing can be used anyway", () => {
  assert.equal(canUseAnyway(agent({ state: "not_logged_in" })), true);
  for (const state of ["ready", "not_installed", "not_supported", "not_connected", "error"] as const) {
    assert.equal(canUseAnyway(agent({ state })), false, state);
  }
  assert.equal(canUseAnyway({ kind: "api", state: "not_logged_in" }), false);
});

test("picker rows: a not-logged-in agent is unverified, a not_supported one only says why", () => {
  const rows = pickerRows(
    pickerView(
      list(
        agent({ id: "grok", state: "not_logged_in", reason: "not logged in", experimental: true }),
        agent({ id: "agy", label: "Antigravity", state: "not_supported", reason: "No ACP mode." }),
      ),
      { query: "" },
    ),
  );
  const grok = rows.find((r) => r.kind === "connect" && r.providerId === "grok");
  const agy = rows.find((r) => r.kind === "connect" && r.providerId === "agy");
  assert.ok(grok?.kind === "connect" && agy?.kind === "connect");
  assert.equal(grok.unverified, true);
  assert.equal(grok.experimental, true);
  assert.equal(agy.unverified, false);
  assert.equal(agy.unsupported, true);
  assert.equal(agy.reason, "No ACP mode.");
  assert.equal(agy.action, "");
  assert.equal(stateText("not_supported"), "Not supported");
  assert.equal(connectAction({ kind: "agent", state: "not_supported" }), "");
});

test("recheck calls the endpoint, reloads the list and says whether the agent is ready", async () => {
  const calls: string[] = [];
  const bridge = {
    recheckProvider: async (id: string) => {
      calls.push(`recheck ${id}`);
      return agent({ id, state: "ready", login: "ok" });
    },
    listProviders: async () => {
      calls.push("list");
      return list(agent({ state: "ready" }));
    },
  } as unknown as Bridge;
  assert.equal(await recheckAgent(bridge, "grok"), true);
  assert.deepEqual(calls, ["recheck grok", "list"]);
});

test("without the endpoint (an older harness) the list is reloaded and read", async () => {
  const bridge = { listProviders: async () => list(agent({ state: "not_logged_in" })) } as unknown as Bridge;
  assert.equal(await recheckAgent(bridge, "grok"), false);
});

test("a refusal's can_force and provider are read off the error", () => {
  const e = new BridgeError(422, "model_unavailable", "m", { provider: "grok", reason: "r", can_force: true });
  assert.equal(canForce(e), true);
  assert.equal(refusedProvider(e), "grok");
  assert.equal(canForce(new BridgeError(422, "model_unavailable", "m", { provider: "grok" })), false);
  assert.equal(canForce(new Error("x")), false);
  assert.equal(refusedProvider("x"), undefined);
});
