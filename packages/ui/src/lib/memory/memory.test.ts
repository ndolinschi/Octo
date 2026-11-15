import assert from "node:assert/strict";
import test from "node:test";
import type { ContextReceipt } from "@octo/agent-client";
import { draftProblem, formatBytes, sortFiles } from "./files";
import { blockLabel, countText, receiptView } from "./receipt";

const receipt: ContextReceipt = {
  turn_id: 7,
  mode: "window",
  recent_exchanges: 5,
  blocks: [
    { name: "memory_index", tokens: 300, cap: 1500, count: 2, ids: ["a.md", "b.md"] },
    { name: "recent_window", tokens: 12_000, cap: 12_000, count: 5, ids: ["1", "3"] },
    { name: "current_turn", tokens: 700, cap: 0, count: 1, ids: ["7"] },
  ],
  total_tokens: 13_000,
  caps_total: 18_000,
  message_count: 11,
  cleared_calls: 1,
  created_at: "2026-01-01T00:00:00Z",
};

test("receiptView: shares add up to the total, cap fill and capped flag, mode and cleared lines", () => {
  const v = receiptView(receipt);
  assert.equal(v.total, 13_000);
  assert.ok(Math.abs(v.segments.reduce((n, s) => n + s.share, 0) - 1) < 1e-9);
  assert.equal(v.segments[0]?.fill, 0.2);
  assert.equal(v.segments[1]?.capped, true);
  assert.equal(v.segments[2]?.fill, null);
  assert.equal(v.totalText, "13k of 18k (trimmed to fit)");
  assert.equal(v.modeText, "Recent only: last 5 requests, 11 messages");
  assert.equal(v.clearedText, "1 tool result was shortened");
});

test("receiptView: a full-mode receipt has no caps, an empty one has zero shares", () => {
  const full = receiptView({
    ...receipt,
    mode: "full",
    blocks: [{ name: "history", tokens: 40_000, cap: 0, count: 3, ids: ["1"] }],
    caps_total: 0,
    cleared_calls: 0,
    message_count: 1,
  });
  assert.equal(full.totalText, "40k tokens");
  assert.equal(full.modeText, "Full history, 1 message");
  assert.equal(full.clearedText, null);
  const empty = receiptView({ ...receipt, blocks: [{ name: "facts", tokens: 0, cap: 1500, count: 0, ids: [] }] });
  assert.equal(empty.segments[0]?.share, 0);
});

test("block labels and counts never show an id", () => {
  assert.equal(blockLabel("recent_window"), "Recent requests");
  assert.equal(blockLabel("some_new_block"), "some new block");
  assert.equal(countText("open_tasks", 3), "3 open tasks");
  assert.equal(countText("memory_index", 1), "1 memory file");
  assert.equal(countText("brand_new", 2), "2 items");
});

test("files: order, sizes, draft limit", () => {
  assert.deepEqual(
    sortFiles([
      { path: "b.md", updated_at: "2026-01-01" },
      { path: "a.md", updated_at: "2026-01-01" },
      { path: "c.md", updated_at: "2026-02-01" },
    ]).map((f) => f.path),
    ["c.md", "a.md", "b.md"],
  );
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2458), "2.4 KB");
  assert.equal(formatBytes(64 * 1024), "64 KB");
  assert.equal(draftProblem("x".repeat(100)), null);
  assert.match(draftProblem("x".repeat(70_000)) ?? "", /^Too large/);
});
