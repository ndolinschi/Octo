import assert from "node:assert/strict";
import test from "node:test";
import type { Provider, ProviderList, ProviderModel } from "@octo/agent-client";
import {
  agentPrefsCodec,
  choosable,
  emptyListNote,
  needsModelRefresh,
  roleModel,
  selectOptions,
  withAgentPrefs,
  cleanModelName,
  customModelsCodec,
  hiddenModelsCodec,
  pickerKey,
  pickerRows,
  pickerView,
  withCustomModel,
  withoutCustomModel,
} from "./modelList";

const model = (id: string, label: string): ProviderModel => ({ id, label, source: "manifest" });
/** A provider as the harness sends it: every field present, empty when unknown. */
const provider = (p: Pick<Provider, "id" | "kind" | "label" | "state"> & Partial<Provider>): Provider => ({
  reason: "",
  install_hint: "",
  login_hint: "",
  models: [],
  default_model: "",
  flat_rate: false,
  ...p,
});

const list: ProviderList = {
  connected: 3,
  suggested: { orchestrator: "claude-sonnet-5-5", fast: "claude-haiku-5-5", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5" },
  providers: [
    provider({
      id: "anthropic-api",
      kind: "api",
      label: "Anthropic API",
      state: "ready",
      models: [model("claude-sonnet-5-5", "Sonnet 5.5"), model("claude-haiku-5-5", "Haiku 5.5")],
    }),
    provider({ id: "octo-router", kind: "router", label: "Octo router", state: "not_connected", models: [] }),
    provider({
      id: "claude-code",
      kind: "agent",
      label: "Claude Code",
      state: "ready",
      models: [model("claude-opus-5-5", "Opus 5.5"), model("claude-sonnet-5-5", "Sonnet 5.5")],
      default_model: "claude-sonnet-5-5",
    }),
    provider({
      id: "copilot",
      kind: "agent",
      label: "GitHub Copilot",
      state: "ready",
      models: [model("gpt-5", "GPT-5"), model("claude-sonnet-5-5", "Sonnet 5.5")],
    }),
    provider({ id: "solo", kind: "agent", label: "Solo", state: "ready", models: [model("only", "Only")] }),
    provider({ id: "empty", kind: "agent", label: "Empty", state: "ready", models: [] }),
    provider({ id: "grok", kind: "agent", label: "Grok", state: "not_installed", models: [model("grok-5", "Grok 5")] }),
  ],
};

test("pickerView: only what can run; the API's models grouped, every ready agent one flat row; the rest one connect row each", () => {
  const v = pickerView(list);
  assert.equal(v.level, "top");
  if (v.level !== "top") return;
  assert.deepEqual(
    v.groups.map((g) => [g.label, g.rows.map((r) => r.key)]),
    [
      ["Anthropic API", ["anthropic-api:claude-sonnet-5-5", "anthropic-api:claude-haiku-5-5"]],
      ["Agents", ["acp:claude-code", "acp:copilot", "acp:solo", "acp:empty"]],
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
  assert.ok(agentRow?.kind === "agent" && agentRow.detail === "Sonnet 5.5");
  // The chosen model of an agent is what its row shows on the right.
  const chosen = pickerView(list, { current: "acp:claude-code/claude-opus-5-5" });
  const chosenRow = chosen.level === "top" ? chosen.groups[1]?.rows[0] : undefined;
  assert.ok(chosenRow?.kind === "agent" && chosenRow.detail === "Opus 5.5");
});

test("pickerView: an agent with no known model still has a second level (Default, Other model…)", () => {
  const v = pickerView(list, { agent: "empty" });
  assert.equal(v.level, "agent");
  if (v.level !== "agent") return;
  assert.deepEqual(
    v.rows.map((r) => [r.kind, r.key]),
    [
      ["default", "acp:empty"],
      ["other", "other:empty"],
    ],
  );
  // One model is a second level too.
  const solo = pickerView(list, { agent: "solo" });
  assert.deepEqual(solo.level === "agent" && solo.rows.map((r) => r.kind), ["default", "model", "other"]);
  // Enter on an agent row opens it; Enter on "Other model…" starts typing; Enter on Default chooses the bare agent.
  const top = pickerView(list);
  const rows = pickerRows(top);
  assert.deepEqual(
    pickerKey(
      top,
      rows.findIndex((r) => r.key === "acp:empty"),
      "Enter",
    ),
    { do: "open", agent: "empty" },
  );
  assert.deepEqual(pickerKey(v, 0, "Enter"), { do: "choose", value: "acp:empty" });
  assert.deepEqual(pickerKey(v, 1, "Enter"), { do: "other", agent: "empty" });
});

test("pickerView: names typed for an agent are listed (as typed), removable, and not duplicated with the harness's own", () => {
  const v = pickerView(list, { agent: "empty", custom: { empty: ["opus", "gpt-5.1-codex"] } });
  assert.ok(v.level === "agent");
  const models = v.rows.filter((r) => r.kind === "model");
  assert.deepEqual(
    models.flatMap((r) => (r.kind === "model" ? [[r.label, r.removable, r.value]] : [])),
    [
      ["opus", true, "acp:empty/opus"],
      ["gpt-5.1-codex", true, "acp:empty/gpt-5.1-codex"],
    ],
  );
  // A harness that already lists the name (source: command) wins; the local copy is not shown twice.
  const known = pickerView(
    { ...list, providers: list.providers.map((p) => (p.id === "empty" ? { ...p, models: [{ id: "opus", label: "opus", source: "command" as const }] } : p)) },
    { agent: "empty", custom: { empty: ["opus"] } },
  );
  assert.ok(known.level === "agent" && known.rows.filter((r) => r.kind === "model").length === 1);
  // Adding and removing.
  assert.deepEqual(withCustomModel(["a"], " b "), ["a", "b"]);
  assert.deepEqual(withCustomModel(["a"], "a"), ["a"]);
  assert.deepEqual(withCustomModel(["a"], "two words"), ["a"]);
  assert.deepEqual(withCustomModel([], "acp:grok/grok-4"), ["grok-4"]);
  assert.deepEqual(withoutCustomModel(["a", "b"], "a"), ["b"]);
  assert.equal(cleanModelName("  "), "");
  assert.deepEqual(customModelsCodec.parse('{"x":["a",3,""],"y":"no"}'), { x: ["a"] });
});

test("pickerView: a provider that is not ready is a connect row, never a model or agent row, and cannot be opened", () => {
  const v = pickerView(list);
  assert.ok(v.level === "top");
  const kinds = new Map(pickerRows(v).map((r) => [r.key, r.kind]));
  assert.equal(kinds.get("connect:grok"), "connect");
  assert.equal(kinds.has("acp:grok"), false);
  assert.equal(pickerView(list, { agent: "grok" }).level, "top");
  const rows = pickerRows(v);
  assert.deepEqual(
    pickerKey(
      v,
      rows.findIndex((r) => r.key === "connect:grok"),
      "Enter",
    ),
    { do: "connect", providerId: "grok" },
  );
  assert.equal(
    pickerKey(
      v,
      rows.findIndex((r) => r.key === "connect:grok"),
      "ArrowRight",
    ),
    null,
  );
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
    ["anthropic-api:claude-sonnet-5-5", "acp:claude-code", "acp:copilot", "acp:solo", "acp:empty"],
  );
  const open = pickerView(list, { agent: "claude-code", hidden: new Set(["acp:claude-code/claude-opus-5-5"]) });
  assert.equal(pickerRows(open).length, 3); // Default, Sonnet, Other model…
});

test("pickerKey: arrows move and wrap, → opens an agent, ← returns to its row, Enter chooses or connects", () => {
  const top = pickerView(list);
  const rows = pickerRows(top);
  const agentAt = rows.findIndex((r) => r.key === "acp:claude-code");
  assert.deepEqual(pickerKey(top, rows.length - 1, "ArrowDown"), { do: "move", active: 0 });
  assert.deepEqual(pickerKey(top, 0, "ArrowUp"), { do: "move", active: rows.length - 1 });
  assert.deepEqual(pickerKey(top, agentAt, "ArrowRight"), { do: "open", agent: "claude-code" });
  // Every ready agent opens, even one with a single model or none.
  assert.deepEqual(
    pickerKey(
      top,
      rows.findIndex((r) => r.key === "acp:empty"),
      "ArrowRight",
    ),
    { do: "open", agent: "empty" },
  );
  assert.equal(pickerKey(top, 0, "ArrowLeft"), null);
  const second = pickerView(list, { agent: "claude-code" });
  assert.deepEqual(pickerKey(second, 0, "ArrowLeft", top), { do: "back", active: agentAt });
  // Row 0 is "Default", row 1 the agent's default model, row 2 the other known one.
  assert.deepEqual(pickerKey(second, 2, "Enter"), { do: "choose", value: "acp:claude-code/claude-opus-5-5" });
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

const open = (id: string, p: ProviderList = list) => {
  const v = pickerView(p, { agent: id });
  assert.equal(v.level, "agent");
  return v as Extract<ReturnType<typeof pickerView>, { level: "agent" }>;
};

test("an agent with no models says why, with the harness's error before a plain sentence and the note after", () => {
  const empty = open("empty").agent;
  assert.deepEqual(emptyListNote(empty, false), { reason: "Empty has not reported its models yet", note: "" });
  assert.equal(emptyListNote(empty, true)?.reason, "Asking Empty for its models…");
  const failed = open("empty", {
    ...list,
    providers: list.providers.map((p) => (p.id === "empty" ? { ...p, models_error: "Empty did not start", models_note: "Aliases from its docs." } : p)),
  }).agent;
  assert.deepEqual(emptyListNote(failed, false), { reason: "Empty did not start", note: "Aliases from its docs." });
  assert.equal(emptyListNote(open("claude-code").agent, false), null);
});

test("opening an agent asks for its models when the list is empty or was never read, and only then", () => {
  assert.equal(needsModelRefresh({ known: 0, refreshedAt: "2026-11-11T12:00:00Z" }), true);
  assert.equal(needsModelRefresh({ known: 2, refreshedAt: "" }), true);
  assert.equal(needsModelRefresh({ known: 2, refreshedAt: "2026-11-11T12:00:00Z" }), false);
});

test("'Other model…' is offered unless the agent says it accepts no model name", () => {
  const kinds = (accepts?: boolean) =>
    open("empty", {
      ...list,
      providers: list.providers.map((p) => (p.id === "empty" ? { ...p, ...(accepts === undefined ? {} : { accepts_custom_model: accepts }) } : p)),
    }).rows.map((r) => r.kind);
  assert.deepEqual(kinds(), ["default", "other"]);
  assert.deepEqual(kinds(true), ["default", "other"]);
  assert.deepEqual(kinds(false), ["default"]);
});

test("an agent whose login is unchecked is ready and chosen like any other; only a failed login goes under Not connected", () => {
  const withLogin = (login: "ok" | "unchecked", state: "ready" | "not_logged_in") => ({
    ...list,
    providers: list.providers.map((p) => (p.id === "solo" ? { ...p, login, state } : p)),
  });
  const rows = (l: ProviderList) => pickerRows(pickerView(l));
  assert.ok(rows(withLogin("unchecked", "ready")).some((r) => r.kind === "agent" && r.providerId === "solo"));
  assert.ok(rows(withLogin("ok", "not_logged_in")).some((r) => r.kind === "connect" && r.providerId === "solo"));
});

test("the agent's row shows the chosen model, else the preferred one (the harness's, else this browser's), else the default", () => {
  const detail = (current: string | undefined, local?: Record<string, { preferred_model?: string }>, preferred?: string) => {
    const l = { ...list, providers: list.providers.map((p) => (p.id === "claude-code" && preferred ? { ...p, preferred_model: preferred } : p)) };
    const row = pickerRows(pickerView(l, { ...(current ? { current } : {}), ...(local ? { localPrefs: local } : {}) })).find(
      (r) => r.kind === "agent" && r.providerId === "claude-code",
    );
    return row?.kind === "agent" ? row.detail : undefined;
  };
  assert.equal(detail(undefined), "Sonnet 5.5");
  assert.equal(detail(undefined, undefined, "claude-opus-5-5"), "Opus 5.5");
  assert.equal(detail(undefined, { "claude-code": { preferred_model: "claude-opus-5-5" } }), "Opus 5.5");
  assert.equal(detail(undefined, { "claude-code": { preferred_model: "claude-opus-5-5" } }, "claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(detail("acp:claude-code/claude-opus-5-5", undefined, "claude-sonnet-5-5"), "Opus 5.5");
  assert.equal(detail(undefined, { "claude-code": { preferred_model: "mystery" } }), "mystery");
});

test("a model select lists the agent's models and keeps a stored name the list lacks", () => {
  const agent = list.providers.find((p) => p.id === "claude-code");
  assert.ok(agent);
  assert.deepEqual(
    selectOptions(agent, "").map((o) => o.id),
    ["claude-sonnet-5-5", "claude-opus-5-5"],
  );
  assert.deepEqual(
    selectOptions(agent, "opus").map((o) => o.id),
    ["claude-sonnet-5-5", "claude-opus-5-5", "opus"],
  );
  assert.equal(roleModel({ id: "x", roles: { fast: "haiku", balanced: "", deep: "" } }, "fast"), "haiku");
  assert.equal(roleModel({ id: "x" }, "deep", { x: { roles: { deep: "opus" } } }), "opus");
});

test("agent preferences kept in this browser: malformed text reads as none, a change merges role by role", () => {
  assert.deepEqual(agentPrefsCodec.parse("not json"), {});
  assert.deepEqual(agentPrefsCodec.parse(JSON.stringify({ a: { preferred_model: "opus", roles: { fast: "haiku", deep: 3 } }, b: 7 })), {
    a: { preferred_model: "opus", roles: { fast: "haiku" } },
  });
  const one = withAgentPrefs(undefined, { roles: { fast: "haiku" } });
  assert.deepEqual(withAgentPrefs(one, { preferred_model: "opus", roles: { deep: "opus", fast: "" } }), {
    preferred_model: "opus",
    roles: { fast: "", deep: "opus" },
  });
});
