import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderList } from "@octo/agent-client";
import { choosable, hiddenModelsCodec, pickerKey, pickerRows, pickerView } from "./modelList";

const list: ProviderList = {
  connected: 3,
  suggested: { orchestrator: "claude-sonnet-5-5", fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5" },
  providers: [
    {
      id: "anthropic-api",
      kind: "api",
      label: "Anthropic API",
      state: "ready",
      models: [
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
        { id: "claude-haiku-5-5", label: "Haiku 5.5" },
      ],
    },
    { id: "octo-router", kind: "router", label: "Octo router", state: "not_connected", models: [] },
    {
      id: "claude-code",
      kind: "agent",
      label: "Claude Code",
      state: "ready",
      models: [
        { id: "claude-opus-5-5", label: "Opus 5.5" },
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      ],
      default_model: "claude-sonnet-5-5",
    },
    {
      id: "copilot",
      kind: "agent",
      label: "GitHub Copilot",
      state: "ready",
      models: [
        { id: "gpt-5", label: "GPT-5" },
        { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      ],
    },
    { id: "solo", kind: "agent", label: "Solo", state: "ready", models: [{ id: "only", label: "Only" }] },
    { id: "grok", kind: "agent", label: "Grok", state: "not_installed", models: [{ id: "grok-5", label: "Grok 5" }] },
  ],
};

test("pickerView: only what can run, grouped by provider; the rest one connect row each", () => {
  const v = pickerView(list);
  assert.equal(v.level, "top");
  if (v.level !== "top") return;
  assert.deepEqual(
    v.groups.map((g) => [g.label, g.rows.map((r) => r.key)]),
    [
      ["Anthropic API", ["anthropic-api:claude-sonnet-5-5", "anthropic-api:claude-haiku-5-5"]],
      ["Claude Code", ["acp:claude-code"]],
      ["GitHub Copilot", ["acp:copilot"]],
      ["Solo", ["acp:solo"]],
    ],
  );
  // Grok's models are not listed; it is one row that opens the connect sheet.
  assert.deepEqual(
    v.unavailable.map((r) => (r.kind === "connect" ? [r.label, r.state, r.action] : null)),
    [
      ["Octo router", "Not connected", "Connect"],
      ["Grok", "Not installed", "How to connect"],
    ],
  );
  const agentRow = v.groups[1]?.rows[0];
  assert.ok(agentRow?.kind === "agent" && agentRow.hasModels && agentRow.detail === "Sonnet 5.5");
  // One model: no "›".
  const solo = v.groups[3]?.rows[0];
  assert.ok(solo?.kind === "agent" && !solo.hasModels);
});

test("pickerView: an agent's second level lists its default first and writes acp:<agent>/<model>", () => {
  const v = pickerView(list, { agent: "claude-code" });
  assert.equal(v.level, "agent");
  if (v.level !== "agent") return;
  assert.deepEqual(
    v.rows.map((r) => (r.kind === "model" ? [r.value, r.isDefault] : null)),
    [
      ["acp:claude-code/claude-sonnet-5-5", true],
      ["acp:claude-code/claude-opus-5-5", false],
    ],
  );
  // An agent that is not ready cannot be opened.
  assert.equal(pickerView(list, { agent: "grok" }).level, "top");
});

test("pickerView: search matches across both levels ('copilot gpt')", () => {
  const v = pickerView(list, { query: "copilot gpt" });
  assert.equal(v.level, "top");
  if (v.level !== "top") return;
  assert.deepEqual(
    v.groups.map((g) => g.rows.map((r) => r.key)),
    [["acp:copilot/gpt-5"]],
  );
  const row = v.groups[0]?.rows[0];
  assert.ok(row?.kind === "model" && row.agentLabel === "GitHub Copilot");
  const sonnet = pickerView(list, { query: "sonnet" });
  assert.equal(sonnet.level === "top" && sonnet.groups.flatMap((g) => g.rows).length, 3);
  const g = pickerView(list, { query: "grok" });
  assert.ok(g.level === "top" && g.groups.length === 0 && g.unavailable.length === 1);
});

test("pickerView: hidden models are left out; an agent's own row stays", () => {
  const v = pickerView(list, { hidden: new Set(["claude-haiku-5-5", "acp:claude-code/claude-opus-5-5"]) });
  assert.ok(v.level === "top");
  assert.deepEqual(
    pickerRows(v)
      .filter((r) => r.kind !== "connect")
      .map((r) => r.key),
    ["anthropic-api:claude-sonnet-5-5", "acp:claude-code", "acp:copilot", "acp:solo"],
  );
  const open = pickerView(list, { agent: "claude-code", hidden: new Set(["acp:claude-code/claude-opus-5-5"]) });
  assert.equal(pickerRows(open).length, 1);
});

test("pickerKey: arrows move and wrap, → opens an agent, ← returns to its row, Enter chooses or connects", () => {
  const top = pickerView(list);
  const rows = pickerRows(top);
  const agentAt = rows.findIndex((r) => r.key === "acp:claude-code");
  assert.deepEqual(pickerKey(top, rows.length - 1, "ArrowDown"), { do: "move", active: 0 });
  assert.deepEqual(pickerKey(top, 0, "ArrowUp"), { do: "move", active: rows.length - 1 });
  assert.deepEqual(pickerKey(top, agentAt, "ArrowRight"), { do: "open", agent: "claude-code" });
  assert.equal(
    pickerKey(
      top,
      rows.findIndex((r) => r.key === "acp:solo"),
      "ArrowRight",
    ),
    null,
  );
  assert.equal(pickerKey(top, 0, "ArrowLeft"), null);
  const second = pickerView(list, { agent: "claude-code" });
  assert.deepEqual(pickerKey(second, 0, "ArrowLeft", top), { do: "back", active: agentAt });
  assert.deepEqual(pickerKey(second, 1, "Enter"), { do: "choose", value: "acp:claude-code/claude-opus-5-5" });
  assert.deepEqual(pickerKey(top, rows.length - 1, "Enter"), { do: "connect", providerId: "grok" });
  assert.equal(pickerKey(top, 0, "a"), null);
});

test("choosable: flat values for selects, agents with and without a model", () => {
  const c = choosable(list);
  assert.deepEqual(
    c.filter((x) => x.group === "Claude Code").map((x) => x.value),
    ["acp:claude-code", "acp:claude-code/claude-sonnet-5-5", "acp:claude-code/claude-opus-5-5"],
  );
  assert.ok(!c.some((x) => x.group === "Grok"));
});

test("hiddenModelsCodec: malformed text reads as none hidden", () => {
  assert.deepEqual(hiddenModelsCodec.parse("not json"), []);
  assert.deepEqual(hiddenModelsCodec.parse('["a", 2, "b"]'), ["a", "b"]);
  assert.deepEqual(hiddenModelsCodec.parse(null), []);
});
