import type { PullRequestFilter, PullRequestList, PullRequestRow } from "@octo/agent-client";

/** Decision 78: the four filter tabs of the picker, in order. */
export const PULL_FILTERS: readonly { id: PullRequestFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review_requested", label: "Review requested" },
  { id: "mine", label: "Mine" },
  { id: "drafts", label: "Drafts" },
];

/** The harness's own match: title, number (`#12` too), author, branch or label contains the text, case-insensitive. */
export function matchesQuery(r: PullRequestRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [r.title, String(r.number), `#${r.number}`, r.author, r.head_ref, ...(r.labels ?? [])].join("\n").toLowerCase();
  return hay.includes(q);
}

export function inFilter(r: PullRequestRow, filter: PullRequestFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "review_requested":
      return r.review_requested;
    case "mine":
      return r.mine === true;
    case "drafts":
      return r.draft;
  }
}

/** Rows of one tab that match the search; the order of `rows` (newest activity first) is kept. */
export function visibleRows(rows: readonly PullRequestRow[], filter: PullRequestFilter, query: string): PullRequestRow[] {
  return rows.filter((r) => inFilter(r, filter) && matchesQuery(r, query));
}

/** How many rows each tab holds, for the numbers in the tabs (the search does not change them). */
export function filterCounts(rows: readonly PullRequestRow[]): Record<PullRequestFilter, number> {
  return {
    all: rows.length,
    review_requested: rows.filter((r) => inFilter(r, "review_requested")).length,
    mine: rows.filter((r) => inFilter(r, "mine")).length,
    drafts: rows.filter((r) => inFilter(r, "drafts")).length,
  };
}

/** The user's own review is older than the head ("new since my review"): the host's flag, or an open review that is behind. */
export function newSinceMyReview(r: PullRequestRow): boolean {
  return r.new_since_my_review === true || r.review?.new_commits === true;
}

/** Joins the pages of one list request (the first page's fields, every page's rows, no row twice). */
export function mergePages(pages: readonly PullRequestList[]): PullRequestList | null {
  const first = pages[0];
  if (!first) return null;
  const seen = new Set<number>();
  const prs = pages.flatMap((p) => p.prs).filter((r) => (seen.has(r.number) ? false : (seen.add(r.number), true)));
  const last = pages[pages.length - 1];
  return { ...first, prs, next_page: last?.next_page ?? null, ...(last?.stale ? { stale: true } : {}) };
}

export type ListCache = { read(key: string): PullRequestList | undefined; write(key: string, list: PullRequestList): void; clear(): void };

/**
 * The last answer per folder, kept for the session so the picker paints at once when it opens again (decision 77) and
 * refreshes in place. React-free; the picker owns when it is read and written.
 */
export function createListCache(): ListCache {
  const map = new Map<string, PullRequestList>();
  return {
    read: (key) => map.get(key),
    write: (key, list) => {
      // An unavailable answer (no gh, not logged in) is not worth painting first: it would hide a fix the user just made.
      if (list.available) map.set(key, list);
      else map.delete(key);
    },
    clear: () => map.clear(),
  };
}

/** "Updated 3 min ago" under the list while the cache answers; "" when nothing is known. */
export function freshness(list: Pick<PullRequestList, "fetched_at">, now: number): string {
  if (!list.fetched_at) return "";
  const s = Math.max(0, Math.round((now - Date.parse(list.fetched_at)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 10) return "Updated just now";
  if (s < 60) return `Updated ${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `Updated ${m} min ago` : `Updated ${Math.round(m / 60)} h ago`;
}

/** The state word a row leads its meta line with (R2, polish step 6b): only when it changes what the reader does. */
export type PullState = { text: string; tone: "warn" | "strong" | "dim" };

/**
 * R2 (polish step 6b): a pull-request row's second line, "Review requested · #482 · mira · 14 files · 8 comments". The
 * state word comes first only when it matters (new since your review, review requested, draft); counts of lines and the
 * time are not here: they sit right-aligned in the row's meta column.
 */
export function pullRowLine(r: PullRequestRow, opts: { showRepo: boolean }): { state: PullState | null; parts: string[] } {
  const state: PullState | null = newSinceMyReview(r)
    ? { text: "New since your review", tone: "warn" }
    : r.review_requested
      ? { text: "Review requested", tone: "strong" }
      : r.draft
        ? { text: "Draft", tone: "dim" }
        : null;
  const parts = [
    `${opts.showRepo && r.repo ? r.repo : ""}#${r.number}`,
    r.mine ? "you" : r.author,
    `${r.changed_files} ${r.changed_files === 1 ? "file" : "files"}`,
  ];
  const comments = r.comments ?? 0;
  if (comments > 0) parts.push(`${comments} ${comments === 1 ? "comment" : "comments"}`);
  // A draft that also needs you keeps "Draft" as a word after the number; a pending draft of yours is worth saying.
  if (r.draft && state?.text !== "Draft") parts.splice(1, 0, "draft");
  if (r.review && r.review.pending_comments > 0) parts.push(`${r.review.pending_comments} pending`);
  return { state, parts };
}
