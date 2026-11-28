import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestList, PullRequestRow, ReviewComment, ReviewThread } from "@octo/agent-client";
import { dirtyList, goBackCommand, checkoutSentence, hasConflicts } from "./checkout";
import { resolveReviewDiffLayout, reviewDiffLayout } from "./diffLayout";
import { createListCache, filterCounts, freshness, mergePages, newSinceMyReview, visibleRows } from "./pullList";
import {
  firstPhrase,
  repliesByThread,
  stepThread,
  threadCountText,
  threadRows,
  threadsLabel,
  threadsOfFile,
  threadSummary,
  threadWhere,
  visibleComments,
} from "./threads";

function row(n: number, extra: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: n,
    title: `Title ${n}`,
    author: "mira",
    draft: false,
    url: "",
    head_ref: `b/${n}`,
    base_ref: "main",
    head_sha: "",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    created_at: "",
    updated_at: "",
    checks: "none",
    review_requested: false,
    review: null,
    ...extra,
  };
}

test("filters, counts and search keep the order", () => {
  const rows = [row(3, { review_requested: true, mine: false }), row(2, { mine: true, draft: true }), row(1, { labels: ["billing"] })];
  assert.deepEqual(
    visibleRows(rows, "all", "").map((r) => r.number),
    [3, 2, 1],
  );
  assert.deepEqual(
    visibleRows(rows, "drafts", "").map((r) => r.number),
    [2],
  );
  assert.deepEqual(
    visibleRows(rows, "all", "#1").map((r) => r.number),
    [1],
  );
  assert.deepEqual(
    visibleRows(rows, "all", "BILL").map((r) => r.number),
    [1],
  );
  assert.deepEqual(filterCounts(rows), { all: 3, review_requested: 1, mine: 1, drafts: 1 });
});

test("new since my review reads the host flag or the open review", () => {
  assert.equal(newSinceMyReview(row(1)), false);
  assert.equal(newSinceMyReview(row(1, { new_since_my_review: true })), true);
  assert.equal(newSinceMyReview(row(1, { review: { id: "r", head_commit: "a", new_commits: true, new_since_submitted: true, pending_comments: 0 } })), true);
});

test("pages merge without repeating a row, and the cache keeps only available answers", () => {
  const page = (rows: PullRequestRow[], next: number | null): PullRequestList => ({ host: "github", available: true, prs: rows, next_page: next });
  const merged = mergePages([page([row(1), row(2)], 2), page([row(2), row(3)], null)]);
  assert.deepEqual(
    merged?.prs.map((r) => r.number),
    [1, 2, 3],
  );
  assert.equal(merged?.next_page, null);
  assert.equal(mergePages([]), null);
  const cache = createListCache();
  cache.write("a", page([row(1)], null));
  assert.equal(cache.read("a")?.prs.length, 1);
  cache.write("a", { host: "github", available: false, prs: [] });
  assert.equal(cache.read("a"), undefined);
});

test("freshness words", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(freshness({ fetched_at: "2026-01-01T11:59:58Z" }, now), "Updated just now");
  assert.equal(freshness({ fetched_at: "2026-01-01T11:59:20Z" }, now), "Updated 40 s ago");
  assert.equal(freshness({ fetched_at: "2026-01-01T11:55:00Z" }, now), "Updated 5 min ago");
  assert.equal(freshness({}, now), "");
});

function thread(id: string, extra: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    path: "a.ts",
    side: "new",
    line: 5,
    resolved: false,
    outdated: false,
    comments: [{ id: "1", author: "jonas", body: "Why   this?\nreally", created_at: "" }],
    ...extra,
  };
}

function noLine(id: string): ReviewThread {
  const { line: _line, ...rest } = thread(id);
  return rest;
}

test("threads split into inline and apart, by line", () => {
  const t = [thread("b", { line: 9 }), thread("a", { line: 2 }), thread("c", { outdated: true }), thread("d", { path: "x.ts" }), noLine("e")];
  const r = threadsOfFile(t, "a.ts");
  assert.deepEqual(
    r.inline.map((x) => x.id),
    ["a", "b"],
  );
  assert.deepEqual(
    r.apart.map((x) => x.id),
    ["c", "e"],
  );
});

test("thread list rows: one line order for drawn and apart threads, where in words, n / p steps", () => {
  const rows = threadRows(
    [thread("b", { line: 9 }), thread("a", { line: 2, start_line: 1 })],
    [thread("c", { outdated: true, line: 4, original_line: 4 }), noLine("e")],
  );
  assert.deepEqual(
    rows.map((r) => [r.thread.id, r.where, r.drawn]),
    [
      ["e", "File", false],
      ["a", "Lines 1–2", true],
      ["c", "Outdated, was line 4", false],
      ["b", "Line 9", true],
    ],
  );
  assert.equal(threadWhere(thread("o", { side: "old" }), true), "Line 5, removed side");
  assert.equal(threadWhere(thread("o", { side: "old" }), false), "Line 5, removed side (not shown in one column)");
  assert.equal(threadsLabel(rows), "4 threads, 2 not at a line");
  assert.equal(threadsLabel(rows.slice(1, 2)), "1 thread");
  assert.equal(firstPhrase("Should 429   be retried? It is not idempotent."), "Should 429 be retried?");
  assert.equal(firstPhrase("x".repeat(80), 10), "xxxxxxxxx…");
  const ids = ["a", "b", "c"];
  assert.equal(stepThread(ids, null, 1), "a");
  assert.equal(stepThread(ids, null, -1), "c");
  assert.equal(stepThread(ids, "a", 1), "b");
  assert.equal(stepThread(ids, "c", 1), null);
  assert.equal(stepThread(ids, "a", -1), null);
  assert.equal(stepThread([], null, 1), null);
});

test("replies fold after two, the latest stay", () => {
  const c = [1, 2, 3, 4, 5];
  assert.deepEqual(visibleComments(c, false), { shown: [1, 4, 5], hidden: 2 });
  assert.deepEqual(visibleComments(c, true), { shown: c, hidden: 0 });
  assert.deepEqual(visibleComments([1, 2, 3], false), { shown: [1, 2, 3], hidden: 0 });
  assert.deepEqual(visibleComments([], false), { shown: [], hidden: 0 });
});

test("summary, counts and pending replies per thread", () => {
  assert.equal(threadSummary(thread("a")), "jonas: Why this? really");
  assert.equal(threadCountText(0, 0), "");
  assert.equal(threadCountText(2, 1), "2 threads, 1 unresolved");
  assert.equal(threadCountText(1, 0), "1 thread, all resolved");
  const mk = (id: string, extra: Partial<ReviewComment>): ReviewComment => ({
    id,
    review_id: "r",
    kind: "reply",
    body: "x",
    state: "pending",
    created_at: "",
    updated_at: "",
    ...extra,
  });
  const m = repliesByThread([
    mk("1", { in_reply_to: "t1" }),
    mk("2", { in_reply_to: "t1" }),
    mk("3", { kind: "line" }),
    mk("4", { in_reply_to: "t2", state: "submitted" }),
  ]);
  assert.equal(m.get("t1")?.length, 2);
  assert.equal(m.has("t2"), false);
});

test("the width floor beats every preference", () => {
  assert.equal(reviewDiffLayout("auto", null), "unified");
  assert.equal(reviewDiffLayout("auto", 900), "unified");
  assert.equal(reviewDiffLayout("auto", 1000), "split");
  assert.equal(reviewDiffLayout("split", 700), "unified");
  assert.equal(reviewDiffLayout("unified", 2000), "unified");
  assert.equal(resolveReviewDiffLayout("split", "auto", 700), "split");
  assert.equal(resolveReviewDiffLayout("unified", "split", 2000), "unified");
  assert.equal(resolveReviewDiffLayout("auto", "auto", 1000), "split");
  assert.equal(resolveReviewDiffLayout("auto", "auto", 900), "unified");
});

test("check out wording and the way back", () => {
  assert.equal(goBackCommand({ previous_branch: "main" }), "git switch main");
  assert.equal(goBackCommand({ previous_branch: "" }), "git switch -");
  assert.equal(goBackCommand({ previous_branch: "main", already_on_branch: true }), null);
  assert.equal(
    checkoutSentence({ mode: "working_copy", branch: "review/1-x", commit: "abcdef123", created: true }),
    "Created and switched to review/1-x at abcdef1.",
  );
  assert.equal(checkoutSentence({ mode: "working_copy", branch: "review/1-x", already_on_branch: true }), "You were already on review/1-x.");
  const files = Array.from({ length: 11 }, (_, i) => ({ path: `f${i}`, status: "modified" as const, code: " M" }));
  assert.deepEqual([dirtyList(files).shown.length, dirtyList(files).more], [8, 3]);
  assert.equal(hasConflicts([{ path: "a", status: "conflicted", code: "UU" }]), true);
  assert.equal(hasConflicts(files), false);
});
