import assert from "node:assert/strict";
import test from "node:test";
import type { Provider, ProviderModel } from "@octo/agent-client";
import {
  billingLine,
  connectSubtitle,
  defaultProviderId,
  foldModels,
  groupOf,
  modelsSummary,
  primaryAction,
  providerGroups,
  reasonLine,
  rowStatus,
} from "./view";

const models = (n: number): ProviderModel[] => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, label: `m${i}`, source: "manifest" }));
const p = (id: string, state: Provider["state"], over: Partial<Provider> = {}): Provider => ({
  id,
  kind: "agent",
  label: id,
  state,
  reason: "",
  install_hint: "",
  login_hint: "",
  models: [],
  default_model: "",
  flat_rate: true,
  ...over,
});

const set: Provider[] = [
  p("api", "not_connected", { kind: "api", flat_rate: false }),
  p("claude", "ready", { models: models(16) }),
  p("copilot", "not_logged_in", { models: models(7) }),
  p("codex", "ready"),
  p("cursor", "not_installed"),
  p("pi", "not_installed"),
  p("broken", "error", { reason: "agent exited" }),
];
const at = (i: number): Provider => {
  const x = set[i];
  if (!x) throw new Error(`no provider ${i}`);
  return x;
};

test("groupOf: ready is connected, a lapsed login or an error needs attention, the rest is not set up", () => {
  assert.deepEqual(
    set.map((x) => groupOf(x)),
    ["not_set_up", "connected", "attention", "connected", "not_set_up", "not_set_up", "attention"],
  );
});

test("rowStatus: one short line per state", () => {
  assert.equal(rowStatus(at(1)), "Ready · 16 models");
  assert.equal(rowStatus(at(3)), "Ready");
  assert.equal(rowStatus(p("x", "ready", { models: models(1) })), "Ready · 1 model");
  assert.equal(rowStatus(at(2)), "Not logged in");
  assert.equal(rowStatus(at(4)), "Not installed");
  assert.equal(rowStatus(at(0)), "Not set up");
});

test("providerGroups: fixed order, empty groups omitted, 'Not set up' folded to one row when something is connected", () => {
  const g = providerGroups(set);
  assert.deepEqual(
    g.map((x) => x.id),
    ["connected", "attention", "not_set_up"],
  );
  assert.deepEqual(
    g[0]?.rows.map((r) => r.id),
    ["claude", "codex"],
  );
  assert.equal(g[2]?.rows.length, 0);
  assert.equal(g[2]?.foldedLabel, "3 more providers can be added");
  assert.equal(g[2]?.foldable, false);
});

test("providerGroups: opened by the row, or holding the selection, the group lists its rows", () => {
  const open = providerGroups(set, { expanded: true })[2];
  assert.deepEqual(
    open?.rows.map((r) => r.id),
    ["api", "cursor", "pi"],
  );
  assert.equal(open?.foldedLabel, null);
  assert.equal(open?.foldable, true);
  assert.equal(providerGroups(set, { selectedId: "cursor" })[2]?.rows.length, 3);
});

test("providerGroups: nothing connected shows every row; agents only say 'agents'", () => {
  const none = providerGroups(set.filter((x) => groupOf(x) !== "connected"));
  assert.deepEqual(
    none.map((x) => [x.id, x.rows.length, x.foldedLabel]),
    [
      ["attention", 2, null],
      ["not_set_up", 3, null],
    ],
  );
  const agents = providerGroups([at(1), p("a", "not_installed"), p("b", "not_installed")])[1];
  assert.equal(agents?.foldedLabel, "2 more agents can be added");
  assert.equal(providerGroups([at(1), p("a", "not_installed")])[1]?.foldedLabel, "1 more agent can be added");
});

test("rows carry the experimental mark and the tone", () => {
  const row = providerGroups([p("ag", "ready", { experimental: true, models: models(2) })])[0]?.rows[0];
  assert.deepEqual(row, { id: "ag", label: "ag", status: "Ready · 2 models", tone: "ok", experimental: true });
});

test("defaultProviderId: the first row of the first group", () => {
  assert.equal(defaultProviderId(set), "claude");
  assert.equal(defaultProviderId(set.filter((x) => groupOf(x) !== "connected")), "copilot");
  assert.equal(defaultProviderId([]), undefined);
});

test("primaryAction: one action per state", () => {
  assert.equal(primaryAction(at(1)), null);
  assert.equal(primaryAction(at(0)), "Connect");
  assert.equal(primaryAction(at(2)), "Check again");
  assert.equal(primaryAction(at(4)), "Check again");
  assert.equal(primaryAction(at(6)), "Check again");
  assert.equal(primaryAction(p("router", "error", { kind: "router" })), "Connect");
});

test("billingLine and reasonLine never talk about environment variables", () => {
  assert.match(billingLine(at(1)), /subscription/);
  assert.match(billingLine(at(0)), /API key/);
  for (const x of set) assert.doesNotMatch(reasonLine(x), /[A-Z]{3,}_[A-Z_]+/);
  assert.equal(reasonLine(at(1)), "");
  assert.equal(reasonLine(at(6)), "Not working: agent exited.");
});

test("modelsSummary and foldModels", () => {
  const now = Date.parse("2026-11-11T14:00:00Z");
  assert.equal(modelsSummary({ models: models(16), models_refreshed_at: "2026-11-11T12:00:00Z" }, now), "16 models · updated 2h ago");
  assert.equal(modelsSummary({ models: [] }, now), "No models listed");
  assert.equal(foldModels(models(16), false).hidden, 10);
  assert.equal(foldModels(models(16), false).shown.length, 6);
  assert.equal(foldModels(models(16), true).shown.length, 16);
  assert.equal(foldModels(models(6), false).hidden, 0);
});

test("connectSubtitle: Ollama alone is said to be connected and not enough", () => {
  assert.match(connectSubtitle([{ kind: "ollama", state: "ready" }]), /^Ollama is connected\. Projects also need/);
  assert.match(connectSubtitle([]), /^Octo needs one of these/);
  assert.match(connectSubtitle([{ kind: "ollama", state: "not_installed" }]), /^Octo needs one of these/);
});
