import assert from "node:assert/strict";
import test from "node:test";
import { planTitle } from "./planTitle";

test("a bold or heading 'Plan…' first line becomes the title and leaves the body", () => {
  assert.deepEqual(planTitle("**Plan: retry failed webhooks with backoff**\n\n1. Add withRetry"), {
    title: "Plan: retry failed webhooks with backoff",
    body: "1. Add withRetry",
  });
  assert.deepEqual(planTitle("\n## Plan\n- a\n- b"), { title: "Plan", body: "- a\n- b" });
  assert.deepEqual(planTitle("# Plan — release checklist #\n\ntext"), { title: "Plan — release checklist", body: "text" });
});

test("text that does not open with its own Plan line keeps the plain title and is shown whole", () => {
  const text = "1. Add withRetry\n2. Run the tests";
  assert.deepEqual(planTitle(text), { title: "Plan", body: text });
  assert.deepEqual(planTitle("**Planned work** is below"), { title: "Plan", body: "**Planned work** is below" });
  assert.deepEqual(planTitle("# Release checklist\n- a"), { title: "Plan", body: "# Release checklist\n- a" });
  assert.deepEqual(planTitle(""), { title: "Plan", body: "" });
});
