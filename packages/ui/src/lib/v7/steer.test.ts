import assert from "node:assert/strict";
import test from "node:test";
import { markSteered } from "./steer";
import { queuedModeTag, steerOutcome, steerUnsupportedFor } from "./steerQueue";

test("an ACP orchestrator cannot be steered", () => {
  assert.equal(steerUnsupportedFor("acp:claude-code/opus"), true);
  assert.equal(steerUnsupportedFor("claude-sonnet-5-5"), false);
  assert.equal(steerUnsupportedFor(undefined), false);
});

test("outcomes by error code", () => {
  assert.equal(steerOutcome("steer_unsupported"), "unsupported");
  assert.equal(steerOutcome("not_found"), "gone");
  assert.equal(steerOutcome("http_error"), "failed");
  assert.equal(steerOutcome(null), "failed");
});

test("a steered text marks one matching prompt, once", () => {
  const marked = markSteered(["use tabs"], ["hello", "use tabs", "use tabs"]);
  assert.deepEqual([...marked], [1]);
  assert.deepEqual([...markSteered([], ["a"])], []);
});

test("queued mode tags only for read-only modes", () => {
  assert.equal(queuedModeTag("ask"), "Ask");
  assert.equal(queuedModeTag("plan"), "Plan");
  assert.equal(queuedModeTag("agent"), null);
  assert.equal(queuedModeTag(undefined), null);
});
