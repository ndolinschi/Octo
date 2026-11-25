import assert from "node:assert/strict";
import test from "node:test";
import { createHttpBridge, type FetchLike } from "./client";
import type { Plugin, PluginAgent } from "./types";

function bridgeReplying(body: unknown) {
  const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  return createHttpBridge({ baseUrl: "http://h:1", fetch });
}

const plugin = (agents: PluginAgent[]): Plugin => ({
  name: "subscription-agents",
  version: "1",
  description: "",
  language_servers: [],
  agents,
  tool_servers: [],
  errors: [],
});

test("plugin agents carry optional login and model fields", async () => {
  const agents: PluginAgent[] = [
    { id: "codex", label: "Codex", available: true, logged_in: true, models: ["gpt-5"], default_model: "gpt-5", hint: "codex login" },
    { id: "grok", label: "Grok", available: true, logged_in: null, models: [] },
    { id: "old", label: "Old server", available: false },
  ];
  const got = await bridgeReplying({ plugins: [plugin(agents)] }).listPlugins();
  const byId = (id: string): PluginAgent => {
    const found = got[0]?.agents.find((a) => a.id === id);
    assert.ok(found, id);
    return found;
  };
  const [codex, grok, old] = [byId("codex"), byId("grok"), byId("old")];
  assert.equal(codex.logged_in, true);
  assert.deepEqual(codex.models, ["gpt-5"]);
  assert.equal(codex.default_model, "gpt-5");
  assert.equal(codex.hint, "codex login");
  assert.equal(grok.logged_in, null);
  assert.deepEqual(grok.models, []);
  assert.equal(old.logged_in, undefined);
  assert.equal(old.models, undefined);
});
