import type { FileChangeSummary, TurnChanges } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { rowKey } from "../../lib/v7/changes";
import { summarizePendingChanges } from "./pendingChanges";

function file(path: string, turn_id = 1, folder = "app"): FileChangeSummary {
  return {
    turn_id,
    folder,
    path,
    kind: "modified",
    added: 1,
    removed: 0,
    created_at: "2026-11-28T00:00:00Z",
    note: "",
    source: "write_file",
    change_ids: [1],
    agent_ids: ["orch"],
  };
}

function turn(turn_id: number, files: FileChangeSummary[], added = 10, removed = 2): TurnChanges {
  return { turn_id, files, added, removed };
}

test("summarizePendingChanges returns null for empty turns or when all latest-turn files are kept", () => {
  assert.equal(summarizePendingChanges(null, new Set()), null);
  assert.equal(summarizePendingChanges([], new Set()), null);
  assert.equal(summarizePendingChanges([turn(1, [])], new Set()), null);
  const f = file("src/a.ts", 5);
  assert.equal(summarizePendingChanges([turn(5, [f])], new Set([rowKey(5, f)])), null);
});

test("summarizePendingChanges computes basenames, extra count, and first unkept file", () => {
  const f1 = file("docs/ARCHITECTURE.md", 9);
  const f2 = file("src/config/config_base.json", 9);
  const f3 = file("src/main.ts", 9);
  const kept = new Set([rowKey(9, f1)]);
  const summary = summarizePendingChanges([turn(9, [f1, f2, f3], 583, 20)], kept);
  assert.ok(summary);
  assert.equal(summary.turnId, 9);
  assert.equal(summary.fileCount, 3);
  assert.equal(summary.added, 583);
  assert.equal(summary.removed, 20);
  assert.deepEqual(summary.preview, ["ARCHITECTURE.md", "config_base.json"]);
  assert.equal(summary.extra, 1);
  assert.equal(summary.firstUnkept, f2);
  assert.equal(summary.keys.length, 3);
});
