import assert from "node:assert/strict";
import test from "node:test";
import { modelLabel, claudeLabel, modelName, readableModelId, parseAcp, servedModel, servedText } from "./models";
import { routeLine, modelIds, budgetState, distinctTails, middleEllipsis, parseBudget, truncateDistinct } from "./modelsMore";

const ACP = [{ id: "claude-code", label: "Claude Code" }];

test("parseAcp splits agent and model", () => {
  assert.deepEqual(parseAcp("acp:claude-code"), { id: "claude-code", model: null });
  assert.deepEqual(parseAcp("acp:claude-code/claude-opus-5-5"), { id: "claude-code", model: "claude-opus-5-5" });
  assert.equal(parseAcp("claude-opus-5-5"), null);
  assert.equal(parseAcp("acp:"), null);
});

test("claudeLabel names Claude ids and leaves the rest whole", () => {
  assert.equal(claudeLabel("claude-sonnet-5-5-20261001"), "Sonnet 5.5");
  assert.equal(claudeLabel("claude-opus-5"), "Opus 5");
  assert.equal(claudeLabel("deepseek/deepseek-v4.1-flash"), "deepseek/deepseek-v4.1-flash");
});

test("modelName renders an acp value as the agent's label and model, never the raw string", () => {
  assert.equal(modelName("acp:claude-code", ACP), "Claude Code");
  assert.equal(modelName("acp:claude-code/claude-opus-5-5", ACP), "Claude Code · Opus 5.5");
  assert.equal(modelName("acp:codex/gpt-5.5", ACP), "Codex · GPT 5.5");
  assert.equal(modelName("claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(modelName("deepseek/deepseek-v4.1-flash-0905"), "DeepSeek v4.1 Flash");
});

test("readableModelId makes an unknown id readable and leaves Claude ids alone", () => {
  assert.equal(readableModelId("deepseek-v4.1-flash"), "DeepSeek v4.1 Flash");
  assert.equal(readableModelId("deepseek-v4.1-flash-1120"), "DeepSeek v4.1 Flash");
  assert.equal(readableModelId("openai/gpt-5-mini-20251022"), "GPT 5 Mini");
  assert.equal(readableModelId("claude-sonnet-5-5-20261001"), "Sonnet 5.5");
  assert.equal(readableModelId("claude-haiku-5-5"), "Haiku 5.5");
});

test("servedModel prefers the served model and keeps the asked one only when it differs", () => {
  assert.deepEqual(servedModel({ model: "claude-sonnet-5-5", served_model: "deepseek-v4.1-flash" }), { name: "DeepSeek v4.1 Flash", asked: "Sonnet 5.5" });
  assert.deepEqual(
    servedModel({ model: "claude-sonnet-5-5", served_model: "deepseek/deepseek-v4.1-flash" }),
    { name: "DeepSeek v4.1 Flash", asked: "Sonnet 5.5" },
    "decision 48: vendor prefix dropped",
  );
  assert.deepEqual(servedModel({ model: "claude-sonnet-5-5", served_model: "claude-sonnet-5-5" }), { name: "Sonnet 5.5", asked: null });
  assert.deepEqual(servedModel({ model: "claude-sonnet-5-5", served_model: null }), { name: "Sonnet 5.5", asked: null });
  assert.equal(servedText({ model: "claude-sonnet-5-5", served_model: "deepseek-v4.1-flash" }), "DeepSeek v4.1 Flash · asked for Sonnet 5.5");
  assert.equal(servedText({ model: "claude-sonnet-5-5" }), "Sonnet 5.5");
});

test("middleEllipsis keeps the requested tail", () => {
  assert.equal(middleEllipsis("short", 10), "short");
  assert.equal(middleEllipsis("deepseek/deepseek-v4.1-flash-0905", 20).length, 20);
  assert.ok(middleEllipsis("deepseek/deepseek-v4.1-flash-0905", 20, 10).endsWith("flash-0905"));
});

test("truncateDistinct never makes two names look alike", () => {
  const names = ["deepseek/deepseek-v4.1-flash-0905", "deepseek/deepseek-v4.1-flash-1120", "deepseek/deepseek-v4.1-flash"];
  const out = truncateDistinct(names, 18);
  assert.equal(new Set(out).size, 3);
  for (const o of out) assert.ok(o.length <= 18);
  assert.deepEqual(distinctTails(["ab-x", "cd-x"]), [3, 3]);
});

test("budgetState: quiet, amber from 80%, red at 100%", () => {
  assert.equal(budgetState(1, null), null);
  assert.equal(budgetState(1, 0), null);
  assert.deepEqual(budgetState(1.2, 5), { text: "$1.20 / $5.00", tone: "fg-3", reached: false, share: 0.24 });
  assert.equal(budgetState(4, 5)?.tone, "warn");
  assert.equal(budgetState(5, 5)?.tone, "err");
  assert.equal(budgetState(5, 5)?.reached, true);
  assert.equal(budgetState(null, 250)?.text, "$0.00 / $250");
});

test("parseBudget", () => {
  assert.equal(parseBudget(""), null);
  assert.equal(parseBudget("$12.505"), 12.51);
  assert.equal(parseBudget("1,000"), 1000);
  assert.ok(Number.isNaN(parseBudget("abc") ?? 0));
  assert.ok(Number.isNaN(parseBudget("-3") ?? 0));
});

test("modelIds ignores lists (auto_candidates) and policy words", () => {
  const models = {
    orchestrator: "claude-opus-5-5",
    fast: "claude-haiku-5-5",
    balanced: "claude-sonnet-5-5",
    deep: "claude-opus-5-5",
    tier_policy: "auto",
    auto_candidates: ["fast", "acp:claude-code"],
  };
  const defaults = { orchestrator: "claude-sonnet-5-5", fast: "", balanced: "claude-sonnet-5-5", deep: "claude-opus-5-5", auto_candidates: [] };
  assert.deepEqual(modelIds(...Object.values(models), ...Object.values(defaults), undefined, null), [
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
  ]);
});

test("routeLine reads a route decision as one quiet line", () => {
  const acp = [{ id: "claude-code", label: "Claude Code" }];
  assert.equal(routeLine({ route_choice: null }), null);
  assert.equal(
    routeLine({ route_choice: "acp:claude-code", route_band: "medium", route_reason: "Claude Code on your subscription was able to do it" }, acp),
    "Chosen automatically: medium task; Claude Code on your subscription was able to do it",
  );
  assert.equal(routeLine({ route_choice: "fast", route_band: "easy", route_reason: null }), "Chosen automatically: easy task; the fast tier");
  assert.equal(routeLine({ route_choice: "deep", route_band: null, route_reason: "no router" }), "Chosen automatically: no router (the deep tier)");
});

test("modelLabel: a label that is the id becomes a readable name; a real label is kept", () => {
  assert.equal(modelLabel({ id: "claude-sonnet-5-5", label: "claude-sonnet-5-5" }), "Sonnet 5.5");
  assert.equal(modelLabel({ id: "claude-opus-4-1", label: "claude-opus-4-1" }), "Opus 4.1");
  assert.equal(modelLabel({ id: "gpt-5", label: "gpt-5" }), "GPT 5");
  assert.equal(modelLabel({ id: "openai/gpt-5-mini", label: "openai/gpt-5-mini" }), "GPT 5 Mini");
  assert.equal(modelLabel({ id: "deepseek/deepseek-v4.1-flash", label: "deepseek/deepseek-v4.1-flash" }), "Deepseek V4.1 Flash");
  assert.equal(modelLabel({ id: "claude-opus-5-5", label: "Claude Opus 5.5" }), "Claude Opus 5.5");
});
