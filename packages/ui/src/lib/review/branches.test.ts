import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewBranch, ReviewBranchList } from "@octo/agent-client";
import { aheadBehindCompact, aheadBehindText, splitName, branchOrder, hasChanges, mergeBranchChunks, openInput } from "./branches";

const b = (name: string, current: boolean, ahead: number, behind: number, date: string): ReviewBranch => ({
  name,
  current,
  ahead,
  behind,
  commit: { sha: "abc1234", subject: "s", date },
});

test("the current branch comes first, then the newest commit", () => {
  const list = [b("old", false, 1, 0, "2026-11-01T00:00:00Z"), b("cur", true, 1, 0, "2026-10-01T00:00:00Z"), b("new", false, 1, 0, "2026-11-10T00:00:00Z")];
  assert.deepEqual(
    branchOrder(list).map((x) => x.name),
    ["cur", "new", "old"],
  );
});

test("ahead and behind in words; nothing ahead is no changes", () => {
  assert.equal(aheadBehindText(b("x", false, 4, 1, "")), "4 ahead, 1 behind");
  assert.equal(aheadBehindText(b("x", false, 7, 0, "")), "7 ahead");
  assert.equal(aheadBehindText(b("x", false, 0, 20, "")), "no changes");
  assert.equal(hasChanges(b("x", false, 0, 3, "")), false);
  assert.equal(hasChanges(b("x", false, 1, 0, "")), true);
});

test("a row opens the branch against the list's base", () => {
  assert.deepEqual(openInput({ name: "feature/x" }, "develop"), { source: "local", base: "develop", head: "feature/x" });
});

test("ahead and behind are compact, with the words for the tooltip", () => {
  assert.equal(aheadBehindCompact({ ahead: 4, behind: 1 }), "↑4 ↓1");
  assert.equal(aheadBehindCompact({ ahead: 7, behind: 0 }), "↑7");
  assert.equal(aheadBehindCompact({ ahead: 0, behind: 9 }), "no changes");
  assert.equal(aheadBehindText({ ahead: 4, behind: 1 }), "4 ahead, 1 behind");
});

test("a long name keeps its end when it is cut", () => {
  assert.deepEqual(splitName("main"), { head: "main", tail: "" });
  assert.deepEqual(splitName("mira/billing-retry"), { head: "mira/billing-retry", tail: "" }, "up to two tails long stays whole");
  assert.deepEqual(splitName("feature/export-invoices-as-csv"), { head: "feature/export-inv", tail: "oices-as-csv" });
});

test("mergeBranchChunks appends branches without duplicates and keeps latest paging", () => {
  const c1: ReviewBranchList = {
    folder: "repo",
    base: "main",
    default_base: "main",
    branches: [b("cur", true, 1, 0, "2026-11-10T00:00:00Z"), b("feat-a", false, 2, 0, "2026-11-09T00:00:00Z")],
    page: 1,
    per_page: 2,
    total: 3,
    next_page: 2,
  };
  const c2: ReviewBranchList = {
    folder: "repo",
    base: "main",
    default_base: "main",
    branches: [b("feat-a", false, 2, 0, "2026-11-09T00:00:00Z"), b("feat-b", false, 1, 1, "2026-11-08T00:00:00Z")],
    page: 2,
    per_page: 2,
    total: 3,
    next_page: null,
  };
  const merged = mergeBranchChunks(c1, c2);
  assert.deepEqual(
    merged.branches.map((x) => x.name),
    ["cur", "feat-a", "feat-b"],
  );
  assert.equal(merged.next_page, null);
  assert.equal(merged.page, 2);
});
