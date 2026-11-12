import type { ReviewThread, ReviewThreadComment, ReviewThreads } from "@octo/agent-client";
import { iso } from "./reviewData";
import { lineOf } from "./reviewDiff";
import type { DemoReviewFile } from "./reviewFiles";

const HOUR = 60 * 60_000;

function c(id: number, author: string, body: string, ago: number, extra: Partial<ReviewThreadComment> = {}): ReviewThreadComment {
  return {
    id: String(9000 + id),
    author,
    body,
    created_at: iso(ago),
    url: `https://github.com/atlas-labs/atlas-api/pull/482#discussion_r${9000 + id}`,
    ...extra,
  };
}

/**
 * Existing review threads of the big demo pull request, anchored by searching the files' texts so they stay on their lines
 * if the sample code is edited: open, resolved, outdated, a long one that folds, and one on the removed side.
 */
export function seedThreads(files: readonly DemoReviewFile[]): ReviewThread[] {
  const text = (path: string, side: "before" | "after") => files.find((f) => f.path === path)?.[side] ?? "";
  const retry = text("src/billing/retry.ts", "after");
  const client = text("src/billing/client.ts", "after");
  const clientBefore = text("src/billing/client.ts", "before");
  return [
    {
      id: "PRRT_demo_1",
      path: "src/billing/retry.ts",
      side: "new",
      line: lineOf(retry, "function retryAfterMs"),
      resolved: false,
      outdated: false,
      comments: [
        c(1, "priya", "Backoff looks right. `Retry-After` can also be an HTTP date; this returns `null` for it. Intended?", 6 * HOUR),
        c(2, "mira", "Yes for now: the billing service only sends seconds. I added a note to the docs.", 4 * HOUR, { in_reply_to: "9001" }),
      ],
    },
    {
      id: "PRRT_demo_2",
      path: "src/billing/retry.ts",
      side: "new",
      line: lineOf(retry, "Math.random() * ceiling"),
      resolved: true,
      outdated: false,
      comments: [
        c(3, "jonas", "Full jitter is the right choice here, thanks for not using equal jitter.", 5 * HOUR),
        c(4, "mira", "Linked the AWS write-up in the description.", 5 * HOUR - 600_000, { in_reply_to: "9003" }),
      ],
    },
    {
      id: "PRRT_demo_3",
      path: "src/billing/client.ts",
      side: "new",
      line: lineOf(client, "if (res.status >= 500)"),
      resolved: false,
      outdated: false,
      comments: [
        c(5, "jonas", "Should 429 retry too? The export hits the rate limit on busy nights.", 20 * HOUR),
        c(6, "mira", "429 carries `Retry-After` more reliably than 5xx, so yes, but I would do it as a follow-up.", 19 * HOUR, { in_reply_to: "9005" }),
        c(7, "jonas", "Fine by me if there is a ticket.", 18 * HOUR, { in_reply_to: "9005" }),
        c(8, "mira", "Opened BILL-212.", 17 * HOUR, { in_reply_to: "9005" }),
        c(9, "priya", "One more thing: `>= 500` includes 501 and 505, which never succeed on retry.", 3 * HOUR, { in_reply_to: "9005" }),
      ],
    },
    {
      id: "PRRT_demo_4",
      path: "src/billing/client.ts",
      side: "old",
      line: lineOf(clientBefore, "/refund"),
      resolved: false,
      outdated: false,
      comments: [c(10, "priya", "The old refund call had no error handling for 409. Do we lose that here?", 2 * HOUR)],
    },
    {
      id: "PRRT_demo_5",
      path: "src/billing/retry.ts",
      side: "new",
      line: 12,
      original_line: 12,
      resolved: false,
      outdated: true,
      comments: [
        c(11, "sam", "Naming nit: `sleep` shadows the helper in `src/util/time.ts`.", 30 * HOUR, {
          commit: "5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b",
          original_line: 12,
        }),
      ],
    },
  ];
}

/** The threads answer: counts per file path as the harness computes them. */
export function threadsAnswer(threads: readonly ReviewThread[], fetchedAt: string): ReviewThreads {
  const counts: Record<string, number> = {};
  const unresolved: Record<string, number> = {};
  for (const t of threads) {
    counts[t.path] = (counts[t.path] ?? 0) + t.comments.length;
    if (!t.resolved) unresolved[t.path] = (unresolved[t.path] ?? 0) + 1;
  }
  return { threads: structuredClone([...threads]), counts_by_path: counts, unresolved_by_path: unresolved, fetched_at: fetchedAt };
}
