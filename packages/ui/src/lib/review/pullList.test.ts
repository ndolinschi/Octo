import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestList, PullRequestRow } from "@octo/agent-client";
import { closesSearch, mergePages, PULL_FILTERS, pullRowLine } from "./pullList";

function row(extra: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 482,
    title: "Retry transient 5xx",
    author: "mira",
    head_ref: "mira/retry",
    base_ref: "main",
    draft: false,
    review_requested: false,
    reviewed_by_me: false,
    checks: "success",
    changed_files: 14,
    additions: 1317,
    deletions: 986,
    updated_at: "2026-11-13T10:00:00Z",
    ...extra,
  } as PullRequestRow;
}

test("pullRowLine: number, author, files and comments; no state word when nothing matters", () => {
  assert.deepEqual(pullRowLine(row({ comments: 8 }), { showRepo: false }), { state: null, parts: ["#482", "mira", "14 files", "8 comments"] });
  assert.deepEqual(pullRowLine(row({ changed_files: 1, comments: 1 }), { showRepo: false }).parts, ["#482", "mira", "1 file", "1 comment"]);
});

test("pullRowLine: the state word leads when it matters, most important first", () => {
  assert.equal(pullRowLine(row({ review_requested: true }), { showRepo: false }).state?.text, "Review requested");
  assert.equal(pullRowLine(row({ draft: true }), { showRepo: false }).state?.text, "Draft");
  const both = pullRowLine(row({ draft: true, review_requested: true, new_since_my_review: true }), { showRepo: false });
  assert.deepEqual(both.state, { text: "New since your review", tone: "warn" });
  assert.deepEqual(both.parts.slice(0, 2), ["#482", "draft"]);
});

test("pullRowLine: you for your own, the repository when rows mix repositories, pending drafts", () => {
  const r = row({ mine: true, repo: "atlas-labs/atlas-api", review: { id: "r1", pending_comments: 2, new_commits: false } as PullRequestRow["review"] });
  assert.deepEqual(pullRowLine(r, { showRepo: true }).parts, ["atlas-labs/atlas-api#482", "you", "14 files", "2 pending"]);
});

test("mergePages deduplicates rows and preserves latest paging metadata", () => {
  const p1: PullRequestList = {
    host: "github",
    available: true,
    page: 1,
    per_page: 2,
    total: 3,
    next_page: 2,
    prs: [row({ number: 1 }), row({ number: 2 })],
  };
  const p2: PullRequestList = {
    host: "github",
    available: true,
    page: 2,
    per_page: 2,
    total: 3,
    next_page: null,
    truncated: true,
    prs: [row({ number: 2 }), row({ number: 3 })],
  };
  const merged = mergePages([p1, p2]);
  assert.ok(merged);
  assert.deepEqual(
    merged.prs.map((p) => p.number),
    [1, 2, 3],
  );
  assert.equal(merged.next_page, null);
  assert.equal(merged.page, 2);
  assert.equal(merged.truncated, true);
});

test("the picker's four chips, the review-requested one named 'To review'", () => {
  assert.deepEqual(
    PULL_FILTERS.map((f) => f.label),
    ["All", "To review", "Mine", "Drafts"],
  );
});

test("closesSearch: Esc closes the opened narrow search only when it is empty", () => {
  assert.equal(closesSearch("Escape", "", true), true);
  assert.equal(closesSearch("Escape", "retry", true), false);
  assert.equal(closesSearch("Escape", "", false), false);
  assert.equal(closesSearch("Enter", "", true), false);
});
