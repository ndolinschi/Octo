import assert from "node:assert/strict";
import test from "node:test";
import { limitTitle, resetsIn, spendText } from "./usageText";

test("limitTitle: a known host by name, the kind in words", () => {
  assert.equal(limitTitle({ provider: "api.anthropic.com", kind: "input_tokens" }), "Anthropic API · input tokens");
  assert.equal(limitTitle({ provider: "llm.example.net", kind: "requests" }), "llm.example.net · requests");
});

test("resetsIn: relative, never a log timestamp", () => {
  const now = Date.parse("2026-11-14T08:00:00Z");
  assert.equal(resetsIn("2026-11-14T08:12:00Z", now), "Resets in 12 min");
  assert.equal(resetsIn("2026-11-14T08:00:10Z", now), "Resets any moment");
  assert.equal(resetsIn("2026-11-14T07:00:00Z", now), "Resets any moment");
  assert.equal(resetsIn("2026-11-14T11:00:00Z", now), "Resets in 3 h");
  assert.equal(resetsIn("2026-11-17T08:00:00Z", now), "Resets in 3 days");
  assert.equal(resetsIn(null, now), "No reset time reported");
});

test("spendText: the project's figure, else the usage table's, and a budget is a total", () => {
  assert.equal(spendText(38.2, 30, "120"), "$38.20 of $120 used, in total.");
  assert.equal(spendText(0, 0.35, ""), "$0.35 spent so far. No budget.");
  assert.equal(spendText(null, 18.31, ""), "$18.31 spent so far. No budget.");
  assert.equal(spendText(undefined, undefined, ""), "Nothing spent yet. No budget.");
  assert.equal(spendText(null, null, "25"), "Spend not known: a model it used has no price. Budget $25 in total.");
  assert.equal(spendText(null, undefined, "25"), "Nothing spent yet. Budget $25 in total.");
});
