import assert from "node:assert/strict";
import test from "node:test";
import { hitRow, searchQuery } from "./requestSearch";

test("short queries are not sent; whitespace is collapsed", () => {
  assert.equal(searchQuery("a"), null);
  assert.equal(searchQuery("   "), null);
  assert.equal(searchQuery("  retry   backoff "), "retry backoff");
});

test("a hit becomes one line with its project", () => {
  const row = hitRow({ project_id: "p1", project_name: "Atlas API", message_id: 42, snippet: "\nAdd retry   to the webhook\nsecond line", date: "2026-11-12" });
  assert.deepEqual(row, { id: "h:p1:42", label: "Add retry to the webhook", detail: "Atlas API" });
});
