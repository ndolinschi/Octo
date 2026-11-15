import assert from "node:assert/strict";
import test from "node:test";
import { rewoundLabel } from "./compact";
import { conflictReason, cutSummary, filesSummary, rewindError } from "./rewind";

test("files summary counts restores and deletes", () => {
  assert.equal(filesSummary({ files: [] }), "No file changes to undo.");
  assert.equal(
    filesSummary({
      files: [
        { folder: "a", path: "x", action: "restore", change_ids: [1] },
        { folder: "a", path: "y", action: "restore", change_ids: [2] },
        { folder: "a", path: "z", action: "delete", change_ids: [3] },
      ],
    }),
    "Restores 2 files and deletes 1 file.",
  );
  assert.equal(filesSummary({ files: [{ folder: "a", path: "z", action: "delete", change_ids: [3] }] }), "Deletes 1 file.");
});

test("cut summary", () => {
  assert.equal(cutSummary({ messages_cut: 1, agents_cut: 0 }), "Removes this request.");
  assert.equal(cutSummary({ messages_cut: 14, agents_cut: 3 }), "Removes this request and 13 later messages and hides 3 sub-agents.");
  assert.equal(cutSummary({ messages_cut: 2, agents_cut: 1 }), "Removes this request and 1 later message and hides 1 sub-agent.");
});

test("reasons, labels and errors", () => {
  assert.match(conflictReason("modified_outside"), /outside/);
  assert.equal(conflictReason("new_reason"), "new_reason");
  assert.match(rewoundLabel(true), /agent starts over/);
  assert.equal(rewoundLabel(false), "Rewound to here");
  assert.match(rewindError("turn_in_progress") ?? "", /Stop it/);
  assert.equal(rewindError("x"), null);
});
