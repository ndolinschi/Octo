import assert from "node:assert/strict";
import test from "node:test";
import type { Provider, ProviderList } from "@octo/agent-client";
import { notReady } from "./modelReadiness";

const agent = (over: Partial<Provider>): Provider => ({
  id: "claude-code",
  kind: "agent",
  label: "Claude Code",
  state: "ready",
  reason: "",
  install_hint: "",
  login_hint: "Log in once: run `claude auth login`.",
  models: [],
  default_model: "",
  flat_rate: true,
  ...over,
});
const api: Provider = { ...agent({}), id: "api", kind: "api", label: "Anthropic API", state: "not_connected", reason: "No API key" };
const list = (...providers: Provider[]): ProviderList =>
  ({ connected: providers.filter((p) => p.state === "ready").length, suggested: {}, providers }) as ProviderList;

test("a logged-out agent: calm sentence, login command, a check target", () => {
  const out = notReady(list(api, agent({ state: "not_logged_in" })), ["acp:claude-code", "acp:claude-code", "acp:claude-code"], false);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.text, "Claude Code is not logged in. You can create the project now and log in later, or choose another model.");
  assert.equal(out[0]?.command, "claude auth login");
  assert.equal(out[0]?.agentId, "claude-code");
});

test("the harness's own login command wins over the hint", () => {
  const out = notReady(list(agent({ state: "not_logged_in", problem: { message: "x", command: "claude" } })), ["acp:claude-code"], false);
  assert.equal(out[0]?.command, "claude");
});

test("not installed and the API without a key; editing words differ", () => {
  assert.match(
    notReady(list(agent({ state: "not_installed" })), ["acp:claude-code"], false)[0]?.text ?? "",
    /^Claude Code is not installed\. You can create the project now/,
  );
  assert.equal(notReady(list(api), ["claude-sonnet-5-5"], false)[0]?.agentId, null);
  assert.match(notReady(list(agent({ state: "not_logged_in" })), ["acp:claude-code"], true)[0]?.text ?? "", /before your next request\.$/);
});

test("everything runnable gives nothing; empty values are skipped", () => {
  assert.deepEqual(notReady(list(agent({})), ["acp:claude-code", ""], false), []);
});
