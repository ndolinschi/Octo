import assert from "node:assert/strict";
import test from "node:test";
import type { DiffHunk, ReviewFile } from "@octo/agent-client";
import { blockAt, changeBlocks, hunksToTexts, stepChange } from "./changes";
import { groupFiles, navigableFiles, sizeChange, stepFile } from "./files";
import { anchorProblem, commentError, commentWhere, lineCommentInput, lineInDiff, linesOf, rangeInDiff } from "./position";
import { reviewKeyAction } from "./keys";
import { parsePullInput } from "./pull";
import { canSubmit, submitProblem, submitText, submittedText } from "./submit";

function file(path: string, group: ReviewFile["group"], order: number, extra: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    status: "modified",
    added: 1,
    removed: 0,
    binary: false,
    old_size: 10,
    new_size: 11,
    group,
    reason: group,
    order,
    folded: group === "mechanical",
    viewed: false,
    changed_since_viewed: false,
    changed_since_submitted: false,
    pending_comments: 0,
    findings: 0,
    ...extra,
  };
}

const L = (type: "context" | "add" | "del", text: string, old?: number, nw?: number) => ({
  type,
  text,
  ...(old !== undefined ? { old } : {}),
  ...(nw !== undefined ? { new: nw } : {}),
});

// old: a b c d e f g h ; new: a b X c d e f g h  (X added after b) then g -> G
const hunks: DiffHunk[] = [
  {
    old_start: 10,
    old_lines: 6,
    new_start: 10,
    new_lines: 7,
    header: "",
    lines: [
      L("context", "a", 10, 10),
      L("context", "b", 11, 11),
      L("add", "X", undefined, 12),
      L("context", "c", 12, 13),
      L("context", "d", 13, 14),
      L("context", "e", 14, 15),
      L("context", "f", 15, 16),
    ],
  },
  {
    old_start: 40,
    old_lines: 3,
    new_start: 41,
    new_lines: 2,
    header: "",
    lines: [L("context", "p", 40, 41), L("del", "q", 41), L("context", "r", 42, 42)],
  },
];

test("groups follow the reading order and fold mechanical files", () => {
  const sections = groupFiles([file("lock", "mechanical", 5), file("t", "tests", 2), file("b", "core", 1), file("a", "core", 0)]);
  assert.deepEqual(
    sections.map((s) => [s.group, s.files.map((f) => f.path), s.folded]),
    [
      ["core", ["a", "b"], false],
      ["tests", ["t"], false],
      ["mechanical", ["lock"], true],
    ],
  );
});

test("] and [ skip folded files unless opened or selected", () => {
  const sections = groupFiles([file("a", "core", 0), file("lock", "mechanical", 1)]);
  assert.deepEqual(
    navigableFiles(sections, new Set(), null).map((f) => f.path),
    ["a"],
  );
  assert.deepEqual(
    navigableFiles(sections, new Set(["mechanical"]), null).map((f) => f.path),
    ["a", "lock"],
  );
  assert.deepEqual(
    navigableFiles(sections, new Set(), "lock").map((f) => f.path),
    ["a", "lock"],
  );
});

test("stepFile moves, stops at the ends, starts at an end with no selection", () => {
  const fs = [file("a", "core", 0), file("b", "core", 1)];
  assert.equal(stepFile(fs, "a", 1)?.path, "b");
  assert.equal(stepFile(fs, "b", 1), null);
  assert.equal(stepFile(fs, "a", -1), null);
  assert.equal(stepFile(fs, null, 1)?.path, "a");
  assert.equal(stepFile(fs, null, -1)?.path, "b");
});

test("sizeChange words", () => {
  assert.equal(sizeChange({ old_size: 2048, new_size: 4096 }), "2.0 KB → 4.0 KB");
  assert.equal(sizeChange({ old_size: -1, new_size: 100 }), "new, 100 B");
  assert.equal(sizeChange({ old_size: 100, new_size: -1 }), "removed, 100 B");
});

test("change blocks: additions land on the first added line, removals on the removed line", () => {
  assert.deepEqual(changeBlocks(hunks), [
    { side: "new", line: 12, end: 12, at: 12 },
    { side: "old", line: 41, end: 41, at: 42 },
  ]);
});

test("j and k step inside the file and then ask for the neighbouring file", () => {
  assert.deepEqual(stepChange(2, null, 1), { kind: "in", index: 0 });
  assert.deepEqual(stepChange(2, null, -1), { kind: "in", index: 1 });
  assert.deepEqual(stepChange(2, 0, 1), { kind: "in", index: 1 });
  assert.deepEqual(stepChange(2, 1, 1), { kind: "file", dir: 1 });
  assert.deepEqual(stepChange(2, 0, -1), { kind: "file", dir: -1 });
  assert.deepEqual(stepChange(0, null, 1), { kind: "file", dir: 1 });
});

test("blockAt finds the block holding a line or the next one", () => {
  const blocks = changeBlocks(hunks);
  assert.equal(blockAt(blocks, "new", 12), 0);
  assert.equal(blockAt(blocks, "old", 30), 1);
  assert.equal(blockAt(blocks, "old", 50), null);
});

test("hunksToTexts keeps real line numbers and blank gaps on both sides", () => {
  const { before, after } = hunksToTexts(hunks);
  const b = before.split("\n");
  const a = after.split("\n");
  assert.equal(a[11], "X");
  assert.equal(a[12], "c");
  assert.equal(b[11], "c");
  assert.equal(b[40], "q");
  assert.equal(a[40], "p");
  assert.equal(b[0], "");
});

test("comment positions: changed lines and three lines around them, per side, inside one hunk", () => {
  assert.ok(lineInDiff(hunks, "new", 12));
  assert.ok(lineInDiff(hunks, "new", 10));
  assert.ok(lineInDiff(hunks, "new", 15));
  assert.ok(!lineInDiff(hunks, "new", 16));
  assert.ok(!lineInDiff(hunks, "new", 5));
  assert.ok(lineInDiff(hunks, "old", 41));
  assert.ok(!lineInDiff(hunks, "new", 100));
  assert.ok(rangeInDiff(hunks, "new", 12, 14));
  assert.ok(!rangeInDiff(hunks, "new", 14, 41));
});

test("anchorProblem explains each refusal and accepts good anchors", () => {
  assert.equal(anchorProblem(hunks, { side: "new", start: 12, end: 14 }, false), null);
  assert.match(anchorProblem(hunks, { side: "new", start: 99, end: 99 }, false) ?? "", /not part of the diff/);
  assert.match(anchorProblem(hunks, { side: "new", start: 14, end: 41 }, false) ?? "", /cross a gap/);
  assert.match(anchorProblem(hunks, { side: "old", start: 41, end: 41 }, true) ?? "", /new version/);
});

test("comment input: one line has no start_line, a range does, ends are put in order", () => {
  assert.deepEqual(lineCommentInput("a.ts", { side: "new", start: 5, end: 5 }, "x"), { path: "a.ts", side: "new", line: 5, body: "x" });
  assert.deepEqual(lineCommentInput("a.ts", { side: "new", start: 9, end: 5 }, "x", "y"), {
    path: "a.ts",
    side: "new",
    line: 9,
    start_line: 5,
    body: "x",
    suggestion: "y",
  });
});

test("where, lines and error texts", () => {
  assert.equal(commentWhere({}), "General");
  assert.equal(commentWhere({ path: "a" }), "a");
  assert.equal(commentWhere({ path: "a", line: 3 }), "a:3");
  assert.equal(commentWhere({ path: "a", line: 5, start_line: 3 }), "a:3–5");
  assert.equal(linesOf("a\nb\nc\nd", 2, 3), "b\nc");
  assert.match(commentError("line_not_in_diff", ""), /not part of the diff/);
  assert.match(commentError("weird", "boom"), /boom/);
});

test("submit text says what is posted and where; a local review posts nothing", () => {
  const gh = { kind: "github" as const, repo: "o/r", number: 123, source: "github:o/r#123" };
  const local = { kind: "local" as const, source: "local:main..feat" };
  assert.equal(submitText(gh, "comment", 4, false), "Post 4 comments to o/r#123 as you");
  assert.equal(submitText(gh, "comment", 1, false), "Post 1 comment to o/r#123 as you");
  assert.equal(submitText(gh, "approve", 0, false), "Approve o/r#123 as you");
  assert.equal(submitText(gh, "request_changes", 2, false), "Post 2 comments and request changes on o/r#123 as you");
  assert.equal(submitText(local, "comment", 3, false), "Mark 3 comments as submitted (nothing is posted)");
  assert.ok(canSubmit("approve", 0, false));
  assert.ok(!canSubmit("comment", 0, false));
  assert.ok(canSubmit("comment", 0, true));
  assert.match(submittedText(local, "comment", 3, false), /Nothing was posted/);
  assert.match(submittedText(gh, "approve", 2, true), /Approved o\/r#123 with 2 comments/);
});

test("submit problems keep everything pending and carry the command", () => {
  const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
  assert.equal(submitProblem(coded("comments_changed", "x")).kind, "comments_changed");
  assert.equal(submitProblem(coded("not_logged_in", "x")).command, "gh auth login");
  assert.match(submitProblem(coded("code_host_error", "422 Unprocessable")).advice, /422 Unprocessable.*still pending/);
  assert.equal(submitProblem(new Error("net")).kind, "other");
});

test("pull input: number, #number, address, nothing", () => {
  assert.deepEqual(parsePullInput(" #42 "), { kind: "number", pr: 42 });
  assert.deepEqual(parsePullInput("7"), { kind: "number", pr: 7 });
  assert.deepEqual(parsePullInput("https://github.com/o/r/pull/9"), { kind: "url", url: "https://github.com/o/r/pull/9" });
  assert.equal(parsePullInput("0"), null);
  assert.equal(parsePullInput("fix the bug"), null);
  assert.equal(parsePullInput(""), null);
});

test("review keys: mapped, ignored with a modifier and inside text fields, kept in the diff editor", () => {
  const k = (key: string, mod = false) => ({ key, ctrlKey: mod, metaKey: false, altKey: false });
  const free = { editable: false, inMonaco: false };
  assert.equal(reviewKeyAction(k("j"), free), "next-change");
  assert.equal(reviewKeyAction(k("k"), free), "prev-change");
  assert.equal(reviewKeyAction(k("]"), free), "next-file");
  assert.equal(reviewKeyAction(k("["), free), "prev-file");
  assert.equal(reviewKeyAction(k("v"), free), "viewed");
  assert.equal(reviewKeyAction(k("c"), free), "comment");
  assert.equal(reviewKeyAction(k("s"), free), "suggest");
  assert.equal(reviewKeyAction(k("x"), free), null);
  assert.equal(reviewKeyAction(k("j", true), free), null);
  assert.equal(reviewKeyAction(k("j"), { editable: true, inMonaco: false }), null);
  assert.equal(reviewKeyAction(k("j"), { editable: true, inMonaco: true }), "next-change");
});
