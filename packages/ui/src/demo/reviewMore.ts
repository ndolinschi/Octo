import type { PullRequestRow } from "@octo/agent-client";
import { PULLS, type PullSpec } from "./reviewData";
import { SMALL_FILES } from "./reviewFiles";

const MIN = 60_000;
const HOUR = 60 * MIN;

const TOPICS: { title: string; author: string; checks: PullRequestRow["checks"]; extra?: Partial<PullRequestRow> }[] = [
  { title: "Add idempotency keys to charge requests", author: "you", checks: "success", extra: { mine: true, comments: 4 } },
  { title: "Paginate the invoice list endpoint", author: "mira", checks: "success", extra: { review_requested: true, comments: 2 } },
  { title: "Replace moment with date-fns in reports", author: "dana", checks: "failure", extra: { comments: 1 } },
  { title: "Cache currency rates for five minutes", author: "you", checks: "pending", extra: { mine: true, comments: 0 } },
  { title: "Fix timezone in the monthly summary email", author: "alex", checks: "success", extra: { reviewed_by_me: true, comments: 6 } },
  { title: "Draft: audit log for admin actions", author: "you", checks: "none", extra: { mine: true, draft: true, comments: 0 } },
  { title: "Upgrade Node to 22 in CI", author: "sam", checks: "success", extra: { labels: ["ci"], comments: 3 } },
  {
    title: "Return 409 when a refund already exists",
    author: "priya",
    checks: "success",
    extra: { review_requested: true, reviewed_by_me: true, new_since_my_review: true, comments: 5 },
  },
  { title: "Extract the money helpers into their own package", author: "jonas", checks: "pending", extra: { comments: 2 } },
  { title: "WIP: webhook signature rotation", author: "dana", checks: "none", extra: { draft: true, comments: 0 } },
  { title: "Log the request id on every billing error", author: "mira", checks: "success", extra: { comments: 1 } },
  { title: "Handle partial refunds in the export", author: "alex", checks: "failure", extra: { comments: 7 } },
  { title: "Tidy the Dockerfile layers", author: "sam", checks: "success", extra: { labels: ["infra"], comments: 0 } },
  { title: "Add a health endpoint for the export worker", author: "you", checks: "success", extra: { mine: true, comments: 2 } },
  { title: "Rename UsageWindow to RateWindow", author: "priya", checks: "success", extra: { comments: 1 } },
  { title: "Bump typescript to 5.9", author: "dana", checks: "success", extra: { labels: ["dependencies"], comments: 0 } },
  { title: "Draft: split billing into read and write clients", author: "jonas", checks: "none", extra: { draft: true, comments: 9 } },
  { title: "Validate currency codes against ISO 4217", author: "mira", checks: "success", extra: { review_requested: true, comments: 0 } },
];

/** Eighteen more pull requests so the picker has a real list to filter and search (about 24 with the first six). */
export const MORE_PULLS: PullSpec[] = TOPICS.map((t, i) => {
  const number = 460 - i * 3;
  const head = t.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28);
  return {
    row: {
      head_sha: "",
      base_ref: "main",
      draft: false,
      labels: [],
      review_requested: false,
      ...t.extra,
      number,
      title: t.title,
      author: t.author,
      head_ref: `${t.author}/${head}`,
      additions: 12 + ((i * 37) % 300),
      deletions: (i * 11) % 90,
      changed_files: 1 + (i % 9),
      checks: t.checks,
      age: (4 + i * 5) * HOUR,
      created: (10 + i * 7) * HOUR,
    },
    files: SMALL_FILES,
    body: "Demo pull request.\n",
    commits: [],
    checks: [],
    conversation: [],
  };
});

/** The pull requests the demo bridge knows: the six with data first, then the rest. */
export const ALL_PULLS: PullSpec[] = [
  ...PULLS.map((p) =>
    p.row.number === 476
      ? { ...p, row: { ...p.row, reviewed_by_me: true, new_since_my_review: true, comments: 3 } }
      : p.row.number === 482
        ? { ...p, row: { ...p.row, comments: 8 } }
        : p,
  ),
  ...MORE_PULLS,
];
