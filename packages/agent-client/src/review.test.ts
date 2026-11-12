import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES, BridgeError, createHttpBridge, type FetchLike } from "./client";
import { applyEvent, emptyProjectState } from "./state";

type Call = { url: string; method: string | undefined; body: string | undefined };

function bridgeWith(body: string) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: true, status: 200, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1/", fetch }), calls };
}

test("review.updated is subscribed to and leaves project state alone", () => {
  assert.ok(BRIDGE_EVENT_TYPES.includes("review.updated"));
  const state = emptyProjectState();
  const event = {
    type: "review.updated" as const,
    seq: 1,
    review_id: "rev_1",
    reason: "comment",
    review: {
      id: "rev_1",
      source: "local:a..b",
      kind: "local" as const,
      title: "t",
      state: "open" as const,
      head_commit: "h",
      pending_comments: 1,
      updated_at: "t",
      last_used_at: "t",
    },
  };
  assert.deepEqual(applyEvent(state, event), { ...state, lastSeq: 1 });
});

test("review.list_updated is subscribed to and leaves project state alone", () => {
  assert.ok(BRIDGE_EVENT_TYPES.includes("review.list_updated"));
  const state = emptyProjectState();
  assert.deepEqual(applyEvent(state, { type: "review.list_updated", seq: 4, folder: "repo" }), { ...state, lastSeq: 4 });
});

test("command events are subscribed to and leave project state alone", () => {
  const state = emptyProjectState();
  for (const type of ["command.started", "command.output", "command.finished"] as const) assert.ok(BRIDGE_EVENT_TYPES.includes(type));
  assert.deepEqual(applyEvent(state, { type: "command.output", seq: 7, run_id: "r", stream: "stdout", text: "hi\n" }), { ...state, lastSeq: 7 });
  assert.deepEqual(applyEvent(state, { type: "command.finished", seq: 8, run_id: "r", exit_code: 0, duration_ms: 12, status: "finished", name: "Tests" }), {
    ...state,
    lastSeq: 8,
  });
});

test("a run request carries the review id in the body", async () => {
  const { bridge, calls } = bridgeWith('{"run_id":"run_1","run":{}}');
  await bridge.runCommand?.("p", "Tests", { reviewId: "rev_1" });
  await bridge.runCommand?.("p", "Tests");
  assert.deepEqual(
    calls.map((c) => c.body),
    ['{"review_id":"rev_1"}', "{}"],
  );
});

test("review.workspace is subscribed to and leaves project state alone", () => {
  assert.ok(BRIDGE_EVENT_TYPES.includes("review.workspace"));
  const state = emptyProjectState();
  const set = { type: "review.workspace" as const, seq: 5, review_workspace: { review_id: "r", path: "/w", title: "t" } };
  assert.deepEqual(applyEvent(state, set), { ...state, lastSeq: 5 });
  assert.deepEqual(applyEvent(state, { type: "review.workspace", seq: 6, review_workspace: null }), { ...state, lastSeq: 6 });
});

test("a dirty working copy error carries the changed files", async () => {
  const body = JSON.stringify({
    error: { code: "dirty_working_copy", message: "2 uncommitted change(s)", files: [{ path: "a.txt", status: "modified", code: " M" }] },
  });
  const fetch: FetchLike = async () => ({ ok: false, status: 409, text: async () => body });
  const bridge = createHttpBridge({ baseUrl: "http://h:1/", fetch });
  await assert.rejects(bridge.checkoutReview?.("p", "r", { mode: "working_copy" }) as Promise<unknown>, (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "dirty_working_copy");
    assert.deepEqual(e.files, [{ path: "a.txt", status: "modified", code: " M" }]);
    return true;
  });
});

test("review methods hit the documented routes", async () => {
  const { bridge, calls } = bridgeWith('{"prs":[],"suggestions":[],"runs":[],"reviews":[],"files":[],"comments":[],"findings":[]}');
  await bridge.listPullRequests?.("p 1", { folder: "my repo" });
  await bridge.listPullRequests?.("p", { filter: "review_requested", q: "fix bug", page: 2, per_page: 10, refresh: true });
  await bridge.listPullRequests?.("p");
  await bridge.listReviews?.("p", "open");
  await bridge.openReview?.("p", { pr: 7 });
  await bridge.patchReview?.("p", "r", { refresh: true });
  await bridge.getReviewFileDiff?.("p", "r", "src/новое имя.go", { context: 5, ignoreWhitespace: true, since: "abc" });
  await bridge.setReviewFileViewed?.("p", "r", "a b/c.go", true);
  await bridge.listReviewThreads?.("p", "r");
  await bridge.listReviewThreads?.("p", "r", { refresh: true });
  await bridge.checkoutReview?.("p", "r", { mode: "working_copy", confirm: true });
  await bridge.listCommandSuggestions?.("p");
  await bridge.runCommand?.("p", "Dev server");
  await bridge.runCommand?.("p", "Tests", { reviewId: "r" });
  await bridge.listCommandRuns?.("p");
  await bridge.listCommandRuns?.("p", { reviewId: "r", limit: 5 });
  await bridge.getCommandRun?.("p", "run 1");
  await bridge.stopCommandRun?.("p", "run 1");
  await bridge.clearReviewWorkspace?.("p");
  await bridge.listReviewComments?.("p", "r");
  await bridge.createReviewComment?.("p", "r", { body: "x" });
  await bridge.updateReviewComment?.("p", "r", "c", { body: "y" });
  await bridge.deleteReviewComment?.("p", "r", "c");
  await bridge.decideReviewFinding?.("p", "r", "f", { status: "dismissed", reason: "style" });
  await bridge.previewReviewSubmit?.("p", "r", { verdict: "approve" });
  await bridge.submitReview?.("p", "r", { verdict: "approve", comment_ids: ["c"] });
  const got = calls.map((c) => `${c.method} ${c.url.replace("http://h:1", "")}`);
  assert.deepEqual(got, [
    "GET /v1/projects/p%201/prs?folder=my%20repo",
    "GET /v1/projects/p/prs?filter=review_requested&q=fix%20bug&page=2&per_page=10&refresh=1",
    "GET /v1/projects/p/prs",
    "GET /v1/projects/p/reviews?state=open",
    "POST /v1/projects/p/reviews",
    "PATCH /v1/projects/p/reviews/r",
    `GET /v1/projects/p/reviews/r/files/src/${encodeURIComponent("новое")}%20${encodeURIComponent("имя")}.go?context=5&ignore_whitespace=1&since=abc`,
    "PATCH /v1/projects/p/reviews/r/files/a%20b/c.go",
    "GET /v1/projects/p/reviews/r/threads",
    "GET /v1/projects/p/reviews/r/threads?refresh=1",
    "POST /v1/projects/p/reviews/r/checkout",
    "GET /v1/projects/p/commands/suggestions",
    "POST /v1/projects/p/commands/Dev%20server/run",
    "POST /v1/projects/p/commands/Tests/run",
    "GET /v1/projects/p/runs",
    "GET /v1/projects/p/runs?review_id=r&limit=5",
    "GET /v1/projects/p/runs/run%201",
    "POST /v1/projects/p/runs/run%201/stop",
    "DELETE /v1/projects/p/review-workspace",
    "GET /v1/projects/p/reviews/r/comments",
    "POST /v1/projects/p/reviews/r/comments",
    "PATCH /v1/projects/p/reviews/r/comments/c",
    "DELETE /v1/projects/p/reviews/r/comments/c",
    "PATCH /v1/projects/p/reviews/r/findings/f",
    "POST /v1/projects/p/reviews/r/submit-preview",
    "POST /v1/projects/p/reviews/r/submit",
  ]);
  assert.equal(bridge.reviewFileRawUrl?.("p", "r", "assets/logo 1.png", "old"), "http://h:1/v1/projects/p/reviews/r/files/assets/logo%201.png?raw=old");
});
