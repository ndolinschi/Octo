import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES, createHttpBridge, type FetchLike } from "./client";
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

test("review methods hit the documented routes", async () => {
  const { bridge, calls } = bridgeWith('{"prs":[],"reviews":[],"files":[],"comments":[],"findings":[]}');
  await bridge.listPullRequests?.("p 1", { folder: "my repo" });
  await bridge.listReviews?.("p", "open");
  await bridge.openReview?.("p", { pr: 7 });
  await bridge.patchReview?.("p", "r", { refresh: true });
  await bridge.getReviewFileDiff?.("p", "r", "src/новое имя.go", { context: 5, ignoreWhitespace: true, since: "abc" });
  await bridge.setReviewFileViewed?.("p", "r", "a b/c.go", true);
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
    "GET /v1/projects/p/reviews?state=open",
    "POST /v1/projects/p/reviews",
    "PATCH /v1/projects/p/reviews/r",
    `GET /v1/projects/p/reviews/r/files/src/${encodeURIComponent("новое")}%20${encodeURIComponent("имя")}.go?context=5&ignore_whitespace=1&since=abc`,
    "PATCH /v1/projects/p/reviews/r/files/a%20b/c.go",
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
