import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_HISTORY, stepHistory } from "./promptHistory";

test("stepHistory walks up/down and restores in-progress draft", () => {
  const hist = ["first prompt", "second prompt", "third prompt"];

  assert.equal(stepHistory([], INITIAL_HISTORY, -1, "draft"), null);
  assert.equal(stepHistory(hist, INITIAL_HISTORY, 1), null);

  const s1 = stepHistory(hist, INITIAL_HISTORY, -1, "work in progress");
  assert.ok(s1);
  assert.deepEqual(s1, { state: { index: 2, draft: "work in progress" }, text: "third prompt" });

  const s2 = stepHistory(hist, s1.state, -1, s1.text);
  assert.ok(s2);
  assert.deepEqual(s2, { state: { index: 1, draft: "work in progress" }, text: "second prompt" });

  const s3 = stepHistory(hist, s2.state, -1, s2.text);
  assert.ok(s3);
  assert.deepEqual(s3, { state: { index: 0, draft: "work in progress" }, text: "first prompt" });

  // At oldest entry, stepping up returns null.
  assert.equal(stepHistory(hist, s3.state, -1, s3.text), null);

  const d1 = stepHistory(hist, s3.state, 1);
  assert.ok(d1);
  assert.deepEqual(d1, { state: { index: 1, draft: "work in progress" }, text: "second prompt" });

  const d2 = stepHistory(hist, d1.state, 1);
  assert.ok(d2);
  assert.deepEqual(d2, { state: { index: 2, draft: "work in progress" }, text: "third prompt" });

  const d3 = stepHistory(hist, d2.state, 1);
  assert.deepEqual(d3, { state: INITIAL_HISTORY, text: "work in progress" });
});
