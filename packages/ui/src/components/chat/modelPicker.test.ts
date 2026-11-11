import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeConfig, Plugin } from "@octo/agent-client";
import { agentModelLabel, buildPickerData, chipLabel, opensLevel, parseModelRef, pickerRows } from "./modelPicker";

const config: BridgeConfig = {
  default_models: { orchestrator: "claude-sonnet-5-5", fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5" },
  default_max_depth: 3,
  acp_orchestrators: [
    { value: "acp:claude-code", id: "claude-code", label: "Claude Code", models: ["opus", "sonnet"], default_model: "sonnet" },
    { value: "acp:copilot", id: "copilot", label: "GitHub Copilot", models: ["gpt-5", "claude-sonnet-4-5"] },
    { value: "acp:grok", id: "grok", label: "Grok", models: [] },
  ],
};
const plugins: Plugin[] = [
  {
    name: "p",
    version: "1",
    description: "",
    language_servers: [],
    tool_servers: [],
    errors: [],
    agents: [
      { id: "claude-code", label: "Claude Code", available: true, logged_in: true },
      { id: "copilot", label: "GitHub Copilot", available: true, logged_in: true },
      { id: "grok", label: "Grok", available: false, hint: "npm i -g grok" },
    ],
  },
];

test("parseModelRef reads API models and acp:<agent>[/<model>]", () => {
  assert.deepEqual(parseModelRef("claude-opus-5-5"), { kind: "api", model: "claude-opus-5-5" });
  assert.deepEqual(parseModelRef("acp:claude-code"), { kind: "acp", agent: "claude-code", model: null });
  assert.deepEqual(parseModelRef("acp:claude-code/opus"), { kind: "acp", agent: "claude-code", model: "opus" });
});

test("agents get their models, default first and marked; a not-ready agent is one row with its hint", () => {
  const data = buildPickerData({ config, plugins, project: undefined });
  assert.deepEqual(
    data.models.map((m) => m.label),
    ["Sonnet 5.5", "Haiku 5.5", "Opus 5.5"],
  );
  const cc = data.agents[0];
  assert.deepEqual(
    cc?.models.map((m) => [m.value, m.label, m.isDefault]),
    [
      ["acp:claude-code/sonnet", "Sonnet", true],
      ["acp:claude-code/opus", "Opus", false],
    ],
  );
  const grok = data.agents[2];
  assert.equal(grok?.ready, false);
  assert.equal(grok?.hint, "npm i -g grok");
  assert.equal(grok && opensLevel(grok), false);
  assert.equal(cc && opensLevel(cc), true);
});

test("API models are not listed when the built-in loop cannot run", () => {
  assert.deepEqual(buildPickerData({ config, plugins, project: undefined, builtinAvailable: false }).models, []);
});

test("the chip reads agent · model", () => {
  const data = buildPickerData({ config, plugins, project: undefined });
  assert.equal(chipLabel("acp:claude-code/opus", data), "Claude Code · Opus");
  assert.equal(chipLabel("acp:claude-code", data), "Claude Code");
  assert.equal(chipLabel("claude-opus-5-5", data), "Opus 5.5");
  assert.equal(agentModelLabel("gpt-5"), "GPT-5");
});

test("search matches across both levels; inside an agent only its models", () => {
  const data = buildPickerData({ config, plugins, project: undefined });
  assert.deepEqual(
    pickerRows(data, "copilot gpt", null).map((r) => r.key),
    ["acp:copilot/gpt-5"],
  );
  assert.deepEqual(
    pickerRows(data, "", null).map((r) => r.kind),
    ["model", "model", "model", "agent", "agent", "agent"],
  );
  assert.deepEqual(
    pickerRows(data, "", "claude-code").map((r) => r.key),
    ["acp:claude-code/sonnet", "acp:claude-code/opus"],
  );
  // A not-ready agent's models are never offered by search.
  assert.deepEqual(
    pickerRows(data, "grok", null).map((r) => r.key),
    ["acp:grok"],
  );
});
