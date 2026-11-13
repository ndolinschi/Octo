import assert from "node:assert/strict";
import test from "node:test";
import type { UsageBucket } from "@octo/agent-client";
import { topModelLines } from "./modelLines";
import { turnLine } from "./turnLine";

const b = (key: string, input: number, output = 0): UsageBucket => ({
  key,
  label: key,
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  requests: 1,
  cost_usd: null,
  cost_estimated: false,
});

test("turnLine: model, then in / out compact", () => {
  assert.equal(turnLine({ model: "opus", inputTokens: 12_400, outputTokens: 3100 }), "opus · 12k in / 3.1k out");
  assert.equal(turnLine({ model: "opus", inputTokens: 900, outputTokens: 40 }), "opus · 900 in / 40 out");
});

test("turnLine leaves out what is not known, never a zero", () => {
  assert.equal(turnLine({ model: "opus" }), "opus");
  assert.equal(turnLine({ inputTokens: 5, outputTokens: 7 }), "5 in / 7 out");
  assert.equal(turnLine({ model: "opus", outputTokens: 7 }), "opus · 7 out");
  assert.equal(turnLine({ model: " ", inputTokens: null }), null);
  assert.equal(turnLine({}), null);
  assert.equal(turnLine({ model: "opus", inputTokens: 0, outputTokens: 0 }), "opus · 0 in / 0 out");
});

test("topModelLines: the three largest, named, empty ones skipped", () => {
  const lines = topModelLines([b("a", 10), b("b", 3000), b("c", 0), b("d", 200, 100), b("e", 2_000_000)], (id) => id.toUpperCase());
  assert.deepEqual(lines, ["E · 2M tokens", "B · 3k tokens", "D · 300 tokens"]);
  assert.deepEqual(topModelLines([]), []);
});
