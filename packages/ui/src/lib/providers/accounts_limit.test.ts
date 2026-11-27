import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@octo/agent-client";
import {
  accountSwitchOffer,
  accountStatus,
  agentBaseLabel,
  defaultAccountName,
  familyOf,
  groupSiblings,
  limitText,
  loginChoices,
  modelsPatchForAccountSwitch,
  namesAgent,
  siblingChoices,
  withProviderLabels,
} from "./accounts";

const agent = (id: string, label: string, over: Partial<Provider> = {}): Provider => ({
  id,
  kind: "agent",
  label,
  state: "ready",
  reason: "",
  install_hint: "",
  login_hint: "",
  models: [],
  default_model: "",
  flat_rate: true,
  ...over,
});

const models = { orchestrator: "acp:claude-code@work/opus", fast: "acp:claude-code@work/haiku", balanced: "acp:claude-code@work", deep: "acp:codex/gpt-5" };

test("a sibling account moves every slot on the failed agent and keeps its model part", () => {
  const patch = modelsPatchForAccountSwitch("acp:claude-code", "claude-code@work", models);
  assert.deepEqual(patch, { orchestrator: "acp:claude-code/opus", fast: "acp:claude-code/haiku", balanced: "acp:claude-code" });
});

test("a sibling's own id is the failed id's base: the default moves to another named account", () => {
  const patch = modelsPatchForAccountSwitch("acp:claude-code@home", "claude-code", {
    orchestrator: "acp:claude-code/opus",
    fast: "claude-haiku-5-5",
    balanced: "x",
    deep: "y",
  });
  assert.deepEqual(patch, { orchestrator: "acp:claude-code@home/opus" });
});

test("the side model and the auto candidates follow the account, without duplicates", () => {
  const patch = modelsPatchForAccountSwitch("acp:claude-code", "claude-code@work", {
    orchestrator: "acp:claude-code@work",
    fast: "f",
    balanced: "b",
    deep: "d",
    side: "acp:claude-code@work/haiku",
    auto_candidates: ["acp:claude-code@work/opus", "acp:claude-code/opus", "deep"],
  });
  assert.equal(patch.side, "acp:claude-code/haiku");
  assert.deepEqual(patch.auto_candidates, ["acp:claude-code/opus", "deep"]);
});

test("any other choice is the composer chip's own rule", () => {
  // A model of the sibling, another agent, a plain model id.
  assert.deepEqual(modelsPatchForAccountSwitch("acp:codex/gpt-5", "claude-code@work", models), {
    orchestrator: "acp:codex/gpt-5",
    fast: "acp:codex",
    balanced: "acp:codex",
  });
  assert.deepEqual(modelsPatchForAccountSwitch("claude-sonnet-5-5", "claude-code@work", models), { orchestrator: "claude-sonnet-5-5" });
  assert.deepEqual(modelsPatchForAccountSwitch("acp:claude-code/opus", "claude-code@work", models), {
    orchestrator: "acp:claude-code/opus",
    fast: "acp:claude-code",
    balanced: "acp:claude-code",
    deep: "acp:claude-code",
  });
});

test("a sibling choice never rewrites slots that are not on the failed agent: no slot on it, an empty patch", () => {
  assert.deepEqual(
    modelsPatchForAccountSwitch("acp:claude-code", "claude-code@work", { orchestrator: "claude-sonnet-5-5", fast: "a", balanced: "b", deep: "c" }),
    {},
  );
  assert.deepEqual(
    modelsPatchForAccountSwitch("acp:claude-code", "claude-code@work", {
      orchestrator: "acp:codex/gpt-5",
      fast: "acp:codex",
      balanced: "acp:codex",
      deep: "acp:codex",
    }),
    {},
  );
});

test("namesAgent: any slot or auto candidate on the agent id counts, a sibling account does not", () => {
  assert.equal(namesAgent("claude-code@work", models), true);
  assert.equal(namesAgent("claude-code", models), false);
  assert.equal(namesAgent("claude-code@work", { orchestrator: "x", auto_candidates: ["acp:claude-code@work/opus"] }), true);
  assert.equal(namesAgent("codex", { orchestrator: "x" }), false);
});

test("limit text: reached, and until a clock time while the reset is ahead", () => {
  const now = Date.parse("2026-11-26T10:00:00");
  assert.equal(limitText(undefined, now), "");
  assert.equal(limitText({ reached_at: "2026-11-26T09:00:00" }, now), "limit reached");
  assert.equal(limitText({ reached_at: "2026-11-26T09:00:00", resets_at: "2026-11-26T09:30:00" }, now), "limit reached");
  assert.equal(limitText({ reached_at: "2026-11-26T09:00:00", resets_at: "2026-11-26T15:05:00" }, now), "limit reached until 15:05");
  assert.equal(limitText({ reached_at: "2026-11-26T09:00:00", resets_at: "not a time" }, now), "limit reached");
});

const family = [
  agent("claude-code", "Claude Code · Personal", { account_env: "CLAUDE_CONFIG_DIR", account_default_label: "Personal" }),
  agent("claude-code@work", "Claude Code · Work", { account_of: "claude-code", account_id: "work", state: "not_logged_in" }),
  agent("claude-code@home", "Claude Code · Home", { account_of: "claude-code", account_id: "home", limit: { reached_at: "2026-11-26T09:00:00" } }),
  agent("claude-code@school", "Claude Code · School", { account_of: "claude-code", account_id: "school" }),
  agent("codex", "Codex"),
];

test("siblings: ready first, then those at their limit, then those that cannot run; the failed one is left out", () => {
  const now = Date.parse("2026-11-26T10:00:00");
  const choices = siblingChoices(family, "claude-code@school", now);
  assert.deepEqual(
    choices.map((c) => c.id),
    ["claude-code", "claude-code@home", "claude-code@work"],
  );
  assert.deepEqual(
    choices.map((c) => c.ready),
    [true, true, false],
  );
  assert.equal(choices[0]?.value, "acp:claude-code");
  assert.equal(choices[1]?.status, "Ready · limit reached");
  assert.equal(choices[2]?.status, "Not logged in");
});

test("a failed id the list does not know still finds its siblings by its base", () => {
  assert.deepEqual(
    siblingChoices(family, "claude-code@gone").map((c) => c.id),
    ["claude-code", "claude-code@school", "claude-code@home", "claude-code@work"],
  );
  assert.deepEqual(siblingChoices(family, "codex"), []);
});

test("groupSiblings puts the accounts of one agent together, default first; one account per agent changes nothing", () => {
  const scattered = [family[1], agent("api", "API", { kind: "api" }), family[0], agent("codex", "Codex"), family[3]].filter(
    (p): p is Provider => p !== undefined,
  );
  assert.deepEqual(
    groupSiblings(scattered).map((p) => p.id),
    ["claude-code", "claude-code@work", "claude-code@school", "api", "codex"],
  );
  const single = [agent("a", "A"), agent("api", "API", { kind: "api" }), agent("b", "B")];
  assert.deepEqual(groupSiblings(single), single);
});

test("login choices: the methods, else the one command, else none; status adds the limit", () => {
  assert.deepEqual(
    loginChoices({
      login_methods: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    }),
    [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  );
  assert.deepEqual(loginChoices({ login_command: "claude auth login" }), [{ id: "", label: "Log in" }]);
  assert.deepEqual(loginChoices({}), []);
  assert.equal(accountStatus({ state: "ready", kind: "agent", limit: { reached_at: "2026-11-26T09:00:00" } }, 0), "Ready · limit reached");
});

test("provider labels win over the config's names; an agent only the config knows is kept", () => {
  const names = withProviderLabels(
    [
      { id: "claude-code", label: "Claude Code" },
      { id: "cursor", label: "Cursor" },
    ],
    family,
  );
  assert.equal(names.find((n) => n.id === "claude-code")?.label, "Claude Code · Personal");
  assert.equal(names.find((n) => n.id === "claude-code@work")?.label, "Claude Code · Work");
  assert.equal(names.find((n) => n.id === "cursor")?.label, "Cursor");
});

const supported = (id: string, label: string, over: Partial<Provider> = {}) => agent(id, label, { account_env: "CLAUDE_CONFIG_DIR", ...over });

test("accounts switch offer: none without support or without a sibling", () => {
  const solo = [supported("claude-code", "Claude Code")];
  assert.deepEqual(accountSwitchOffer(solo, "claude-code", { orchestrator: "acp:claude-code" }), { kind: "none" });
  const unsupported = [agent("grok", "Grok", { account_unsupported: "one keyring" }), agent("grok@x", "Grok · X", { account_of: "grok" })];
  assert.deepEqual(accountSwitchOffer(unsupported, "grok", { orchestrator: "acp:grok" }), { kind: "none" });
});

test("accounts switch offer: unnamed when no slot is on the failed account, else the choices and whether any can run", () => {
  const list = [
    supported("claude-code", "Claude Code · Personal"),
    agent("claude-code@work", "Claude Code · Work", { account_of: "claude-code", state: "not_logged_in" }),
  ];
  assert.deepEqual(accountSwitchOffer(list, "claude-code", { orchestrator: "acp:codex" }), { kind: "unnamed" });
  const offer = accountSwitchOffer(list, "claude-code", { orchestrator: "acp:claude-code/opus" });
  assert.equal(offer.kind, "choices");
  if (offer.kind === "choices") {
    assert.equal(offer.anyReady, false);
    assert.deepEqual(
      offer.choices.map((c) => c.id),
      ["claude-code@work"],
    );
  }
});

test("the family of an agent and the default account's name", () => {
  assert.deepEqual(
    familyOf(family, "claude-code").map((p) => p.id),
    ["claude-code", "claude-code@work", "claude-code@home", "claude-code@school"],
  );
  assert.equal(defaultAccountName({ account_default_label: "Personal" }), "Personal");
  assert.equal(defaultAccountName({}), "Default");
  assert.equal(agentBaseLabel({ label: "Claude Code · Personal", account_default_label: "Personal" }), "Claude Code");
  assert.equal(agentBaseLabel({ label: "Claude Code" }), "Claude Code");
});
