import assert from "node:assert/strict";
import test from "node:test";
import { contextMeter, shareText } from "./contextMeter";

const base = { agent_id: "a", model: "m", estimated: true };

test("contextMeter orders parts and folds tiny ones into Other", () => {
  const m = contextMeter({
    ...base,
    window_tokens: 200_000,
    used_tokens: 50_000,
    parts: [
      { key: "system", tokens: 2_000 },
      { key: "tools", tokens: 100 },
      { key: "notes", tokens: 50 },
      { key: "messages", tokens: 30_000 },
      { key: "tool_results", tokens: 17_850 },
      { key: "summary", tokens: 0 },
    ],
  });
  assert.equal(m.percent, "25% used");
  assert.equal(m.amount, "50k / 200k");
  assert.deepEqual(
    m.rows.map((r) => r.key),
    ["messages", "tool_results", "system", "other"],
  );
  assert.equal(m.rows.at(-1)?.tokens, 150);
  assert.equal(m.estimated, true);
});

test("contextMeter without a window", () => {
  const m = contextMeter({ ...base, estimated: false, window_tokens: null, used_tokens: 1_200, parts: [{ key: "messages", tokens: 1_200 }] });
  assert.equal(m.percent, null);
  assert.equal(m.amount, "1.2k tokens");
  assert.equal(m.fill, 0);
});

test("a tiny use is <1%", () => {
  assert.equal(contextMeter({ ...base, window_tokens: 1_000_000, used_tokens: 900, parts: [] }).percent, "<1% used");
  assert.equal(shareText(0.004), "<1%");
  assert.equal(shareText(0.42), "42%");
});
