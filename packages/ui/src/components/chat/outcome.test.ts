import assert from "node:assert/strict";
import test from "node:test";
import { isCompactRetry, runRetry, sentence, splitHint } from "./outcome";

test("a hint sent apart is said once, even when the error already ends with it", () => {
  assert.deepEqual(splitHint("budget reached", "Raise the budget."), { error: "budget reached", hint: "Raise the budget." });
  assert.deepEqual(splitHint("budget reached. Raise the budget.", "Raise the budget."), { error: "budget reached", hint: "Raise the budget." });
  assert.deepEqual(splitHint("budget reached\nHint: Raise the budget.", "Raise the budget."), { error: "budget reached", hint: "Raise the budget." });
  assert.deepEqual(splitHint("Raise the budget. Then retry", "Raise the budget."), { error: "Raise the budget. Then retry", hint: "Raise the budget." });
  assert.deepEqual(splitHint(null, undefined), { error: "", hint: null });
});

test("sentence ends with one stop", () => {
  assert.equal(sentence("a"), "a.");
  assert.equal(sentence("a."), "a.");
});

test("Retry is busy only while sending: off again after success and after a failed send", async () => {
  for (const fails of [false, true]) {
    const log: boolean[] = [];
    const errors: unknown[] = [];
    await runRetry(() => (fails ? Promise.reject(new Error("409")) : Promise.resolve()), "again", {
      setBusy: (b) => log.push(b),
      onError: (e) => errors.push(e),
    });
    assert.deepEqual(log, [true, false]);
    assert.equal(errors.length, fails ? 1 : 0);
  }
});

test("isCompactRetry identifies /compact prompts and compact commands cleanly", () => {
  assert.equal(isCompactRetry("/compact"), true);
  assert.equal(isCompactRetry(" /COMPACT  now "), true);
  assert.equal(isCompactRetry("anything", "compact"), true);
  assert.equal(isCompactRetry("/compactify"), false);
  assert.equal(isCompactRetry("hello world"), false);
  assert.equal(isCompactRetry(null, undefined), false);
  assert.equal(isCompactRetry(null, "compact"), true);
});
