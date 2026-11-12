import {
  BridgeError,
  type Bridge,
  type DiffHunk,
  type OpenReviewInput,
  type PullRequestList,
  type PullRequestRow,
  type Review,
  type ReviewComment,
  type ReviewFile,
  type ReviewFileDiff,
  type ReviewFiles,
  type ReviewFinding,
  type ReviewSubmitInput,
  type ReviewSubmitPreview,
  type ReviewVerdict,
} from "@octo/agent-client";
import { commentableRuns } from "../lib/review/position";
import { BRANCH_COMMITS, DEMO_HOST, DEMO_REPO, iso, PULLS, type PullSpec } from "./reviewData";
import { SMALL_FILES, type DemoReviewFile } from "./reviewFiles";
import { countLines, lineDiff, lineOf } from "./reviewDiff";
import { newId, type ProjectRecord } from "./store";

const LATENCY_MS = 70;
const TOO_LARGE_LINES = 2000;
const delay = () => new Promise((r) => setTimeout(r, LATENCY_MS));
const err = (status: number, code: string, message: string) => new BridgeError(status, code, message);

type Knobs = { nogh: boolean; notloggedin: boolean; empty: boolean; fail: boolean; submitlogin: boolean };

/** `?review=nogh|notloggedin|empty|fail` (comma separated; `submitlogin` makes the first submit say not logged in). */
function knobs(): Knobs {
  const raw = typeof location === "undefined" ? "" : (new URLSearchParams(location.search).get("review") ?? "");
  const set = new Set(raw.split(",").map((s) => s.trim()));
  return { nogh: set.has("nogh"), notloggedin: set.has("notloggedin"), empty: set.has("empty"), fail: set.has("fail"), submitlogin: set.has("submitlogin") };
}

type Rec = {
  review: Review;
  spec: PullSpec | null;
  files: DemoReviewFile[];
  viewed: Set<string>;
  changedSinceViewed: Set<string>;
  changedSinceSubmitted: Set<string>;
  comments: ReviewComment[];
  findings: ReviewFinding[];
  failedOnce: boolean;
};

const bytes = (t: string | null) => (t === null ? -1 : new TextEncoder().encode(t).length);

/** A tiny SVG for the image diff's two sides, as a data URL (no network in the demo). */
function pictureUrl(side: "new" | "old"): string {
  const fill = side === "old" ? "#8a8a8a" : "#5c9dff";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" rx="8" fill="#222"/><rect x="24" y="24" width="${side === "old" ? 120 : 200}" height="28" rx="6" fill="${fill}"/><rect x="24" y="68" width="${side === "old" ? 180 : 240}" height="28" rx="6" fill="${fill}" opacity=".7"/><rect x="24" y="112" width="${side === "old" ? 80 : 160}" height="28" rx="6" fill="${fill}" opacity=".45"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function diffFor(f: DemoReviewFile, context: number, ignoreWhitespace: boolean): DiffHunk[] {
  if (f.binary || f.tooLarge) return [];
  return lineDiff(f.before, f.after, context, ignoreWhitespace);
}

const countsFor = (f: DemoReviewFile) => f.tooLarge ?? (f.binary ? { added: 0, removed: 0 } : countLines(diffFor(f, 3, false)));

function fileOut(r: Rec, f: DemoReviewFile, order: number): ReviewFile {
  const counts = countsFor(f);
  const sizes = f.sizes ?? { old: bytes(f.before), new: bytes(f.after) };
  return {
    path: f.path,
    ...(f.old_path ? { old_path: f.old_path } : {}),
    status: f.status,
    added: counts.added,
    removed: counts.removed,
    binary: f.binary === true,
    ...(f.image ? { image: f.image } : {}),
    old_size: f.status === "added" ? -1 : sizes.old,
    new_size: f.status === "deleted" ? -1 : sizes.new,
    ...(f.similarity !== undefined ? { similarity: f.similarity } : {}),
    group: f.group,
    reason: f.reason,
    order,
    folded: f.group === "mechanical",
    ...(f.tooLarge ? { large: true } : {}),
    viewed: r.viewed.has(f.path),
    changed_since_viewed: r.changedSinceViewed.has(f.path),
    changed_since_submitted: r.changedSinceSubmitted.has(f.path),
    pending_comments: r.comments.filter((c) => c.path === f.path && c.state === "pending").length,
    findings: r.findings.filter((x) => x.path === f.path && x.status === "new").length,
  };
}

function fileList(r: Rec): ReviewFile[] {
  return r.files.map((f, i) => fileOut(r, f, i));
}

function totals(r: Rec) {
  const fs = fileList(r);
  return {
    files: fs.length,
    added: fs.reduce((n, f) => n + f.added, 0),
    removed: fs.reduce((n, f) => n + f.removed, 0),
    mechanical: fs.filter((f) => f.folded).length,
  };
}

function reviewOut(r: Rec): Review {
  const fs = fileList(r);
  const t = totals(r);
  return {
    ...r.review,
    pending_comments: r.comments.filter((c) => c.state === "pending").length,
    findings: r.findings.filter((f) => f.status === "new").length,
    viewed_count: fs.filter((f) => f.viewed).length,
    totals: t,
    large_pr: t.files > 60 || t.added + t.removed > 3000,
    updated_at: iso(),
  };
}

function pending(r: Rec): ReviewComment[] {
  return r.comments.filter((c) => c.state === "pending");
}

function previewOf(r: Rec, input: ReviewSubmitInput): ReviewSubmitPreview {
  const comments = pending(r);
  const general = comments.filter((c) => !c.path).map((c) => c.body);
  const body = [input.body?.trim() ?? "", ...general].filter(Boolean).join("\n\n");
  const github = r.review.kind === "github";
  const event = { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" }[input.verdict];
  return {
    verdict: input.verdict,
    body,
    comments,
    ...(github
      ? {
          payload: {
            event,
            body,
            comments: comments
              .filter((c) => c.path && c.line !== undefined)
              .map((c) => ({
                path: c.path,
                line: c.line,
                side: c.side === "old" ? "LEFT" : "RIGHT",
                ...(c.start_line !== undefined ? { start_line: c.start_line } : {}),
                body: c.suggestion !== undefined ? `${c.body}\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\`` : c.body,
              })),
          },
        }
      : {}),
    posts: github,
    head_commit: r.review.head_commit,
  };
}

function seedFindings(r: Rec): ReviewFinding[] {
  const retry = r.files.find((f) => f.path === "src/billing/retry.ts")?.after ?? "";
  const mk = (
    n: number,
    path: string,
    line: number,
    severity: ReviewFinding["severity"],
    statement: string,
    scenario: string,
    rank: number,
  ): ReviewFinding => ({
    id: `fnd_${n}`,
    review_id: r.review.id,
    path,
    start_line: line,
    end_line: line + 1,
    severity,
    statement,
    scenario,
    verdict: "plausible",
    rank,
    status: "new",
    created_at: iso(MIN_AGO),
    updated_at: iso(MIN_AGO),
  });
  return [
    mk(
      1,
      "src/billing/retry.ts",
      lineOf(retry, "function retryAfterMs"),
      "medium",
      "`Retry-After` is parsed as seconds only; the HTTP-date form falls back to the computed delay.",
      "A 503 with `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` is retried after the jittered delay, ignoring the server's hint.",
      1,
    ),
    mk(
      2,
      "src/billing/retry.ts",
      lineOf(retry, "return Math.random()"),
      "low",
      "The jitter can return a delay of almost zero, which retries immediately on the first attempt.",
      "With full jitter two clients that failed together may both retry within a millisecond.",
      2,
    ),
  ];
}

const MIN_AGO = 5 * 60_000;
const headOf = (n: number) => `${n.toString(16).padStart(6, "0")}${"ab12cd34".repeat(4)}ef`.slice(0, 40);

/** Adds the review members (RV1's optional methods) to a demo bridge: six pull requests, local branches, every write. */
export function withDemoReview(base: Bridge, records: Map<string, ProjectRecord>): Bridge {
  const stores = new Map<string, Map<string, Rec>>();
  const k = knobs();
  const project = (id: string): { rec: ProjectRecord; reviews: Map<string, Rec> } => {
    const rec = records.get(id);
    if (!rec) throw err(404, "not_found", "project not found");
    let reviews = stores.get(id);
    if (!reviews) {
      reviews = new Map();
      stores.set(id, reviews);
    }
    return { rec, reviews };
  };
  const folderLabel = (rec: ProjectRecord) => rec.project.folders[0]?.label ?? "repo";

  const build = (rec: ProjectRecord, source: string, spec: PullSpec | null, input: OpenReviewInput): Rec => {
    const files = spec ? spec.files : [];
    const head = spec ? headOf(spec.row.number) : "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
    const r: Rec = {
      spec,
      files: spec ? files : SMALL_FILES,
      viewed: new Set(files.filter((f) => f.viewed).map((f) => f.path)),
      changedSinceViewed: new Set(files.filter((f) => f.changedSinceViewed).map((f) => f.path)),
      changedSinceSubmitted: new Set(),
      comments: [],
      findings: [],
      failedOnce: false,
      review: {
        id: newId("rv"),
        source,
        kind: spec ? "github" : "local",
        folder: input.folder ?? folderLabel(rec),
        ...(spec ? { repo: DEMO_REPO, number: spec.row.number } : {}),
        title: spec ? spec.row.title : `Local branch ${input.head ?? "HEAD"}`,
        body: spec ? spec.body : "",
        ...(spec ? { author: spec.row.author, url: `https://${DEMO_HOST}/${DEMO_REPO}/pull/${spec.row.number}` } : {}),
        base_ref: spec ? "main" : (input.base ?? "main"),
        head_ref: spec ? spec.row.head_ref : (input.head ?? "HEAD"),
        base_commit: "0b1c2d3e4f5a69788796a5b4c3d2e1f001122334",
        head_commit: head,
        worktree_path: `/home/you/.octo/projects/demo/review/${spec?.row.number ?? "local"}`,
        worktree_present: true,
        state: "open",
        created_at: iso(MIN_AGO),
        updated_at: iso(),
        last_used_at: iso(),
        pending_comments: 0,
        meta: spec
          ? {
              draft: spec.row.draft,
              pr_state: "OPEN",
              mergeable: "MERGEABLE",
              labels: spec.row.labels ?? [],
              checks_state: spec.row.checks,
              checks: spec.checks,
              commits: spec.commits,
              conversation: spec.conversation,
              refreshed_at: iso(),
            }
          : { commits: BRANCH_COMMITS, refreshed_at: iso() },
        totals: { files: 0, added: 0, removed: 0, mechanical: 0 },
        findings: 0,
        viewed_count: 0,
        large_pr: false,
      },
    };
    if (spec?.row.number === 482) r.findings = seedFindings(r);
    if (spec?.resubmit) {
      r.review.last_submitted_head = "5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b";
      r.review.last_submitted_at = iso(24 * 60 * 60_000);
      for (const f of files.slice(0, 2)) r.changedSinceSubmitted.add(f.path);
      const lim = files.find((f) => f.path === "src/usage/limiter.ts");
      r.comments.push(
        mkComment(r, {
          path: "src/usage/limiter.ts",
          side: "new",
          line: lineOf(lim?.after ?? "", "< now - windowMs"),
          body: "Is `<` right here? A hit exactly one window old should still count.",
        }),
      );
    }
    return r;
  };

  const mkComment = (
    r: Rec,
    c: { path?: string; side?: "new" | "old"; line?: number; start_line?: number; body: string; suggestion?: string; finding_id?: string },
  ): ReviewComment => ({
    id: newId("rc"),
    review_id: r.review.id,
    kind: !c.path ? "general" : c.line === undefined ? "file" : c.start_line !== undefined && c.start_line < c.line ? "range" : "line",
    ...(c.path ? { path: c.path } : {}),
    ...(c.line !== undefined ? { side: c.side ?? "new", line: c.line } : {}),
    ...(c.start_line !== undefined ? { start_line: c.start_line } : {}),
    body: c.body,
    ...(c.suggestion !== undefined ? { suggestion: c.suggestion } : {}),
    ...(c.finding_id ? { finding_id: c.finding_id } : {}),
    state: "pending",
    created_at: iso(),
    updated_at: iso(),
  });

  const find = (pid: string, id: string): Rec => {
    const r = project(pid).reviews.get(id);
    if (!r) throw err(404, "not_found", "review not found");
    return r;
  };

  /** The seeded review of the pull request that has new commits since the user's review exists from the start. */
  const seeded = (pid: string) => {
    const { rec, reviews } = project(pid);
    const spec = PULLS.find((p) => p.resubmit);
    if (!spec || [...reviews.values()].some((r) => r.spec === spec)) return;
    const r = build(rec, `github:${DEMO_REPO}#${spec.row.number}`, spec, {});
    reviews.set(r.review.id, r);
  };

  const rows = (pid: string): PullRequestRow[] => {
    seeded(pid);
    const { reviews } = project(pid);
    return PULLS.map((spec) => {
      const r = [...reviews.values()].find((x) => x.spec === spec);
      const sums =
        spec.row.additions === 0
          ? spec.files.map(countsFor).reduce((a, c) => ({ add: a.add + c.added, del: a.del + c.removed }), { add: 0, del: 0 })
          : { add: 0, del: 0 };
      const { age, created, ...row } = spec.row;
      return {
        ...row,
        head_sha: r?.review.head_commit ?? headOf(spec.row.number),
        additions: spec.row.additions || sums.add,
        deletions: spec.row.deletions || sums.del,
        changed_files: spec.row.changed_files || spec.files.length,
        url: `https://${DEMO_HOST}/${DEMO_REPO}/pull/${spec.row.number}`,
        created_at: iso(created),
        updated_at: iso(age),
        review: r
          ? {
              id: r.review.id,
              head_commit: r.review.head_commit,
              ...(r.review.last_submitted_head ? { last_submitted_head: r.review.last_submitted_head } : {}),
              new_commits: r.changedSinceSubmitted.size > 0,
              new_since_submitted: r.changedSinceSubmitted.size > 0,
              pending_comments: pending(r).length,
            }
          : null,
      };
    });
  };

  const list = async (pid: string): Promise<PullRequestList> => {
    await delay();
    const { rec } = project(pid);
    const common = { host: DEMO_HOST, folder: folderLabel(rec) };
    if (k.fail) throw err(500, "git_error", "git fetch failed: could not resolve host");
    if (k.nogh)
      return {
        ...common,
        available: false,
        reason: "gh_not_installed",
        message: "The GitHub CLI (gh) is not installed, so pull requests cannot be listed.",
        command: "brew install gh && gh auth login",
        prs: [],
      };
    if (k.notloggedin)
      return {
        ...common,
        repo: DEMO_REPO,
        available: false,
        reason: "not_logged_in",
        message: "gh is installed but you are not logged in to github.com.",
        command: "gh auth login",
        prs: [],
      };
    return { ...common, repo: DEMO_REPO, available: true, prs: k.empty ? [] : rows(pid) };
  };

  return {
    ...base,
    listPullRequests: (pid) => list(pid),
    listReviews: async (pid) => {
      await delay();
      seeded(pid);
      return [...project(pid).reviews.values()].map((r) => {
        const o = reviewOut(r);
        return {
          id: o.id,
          source: o.source,
          kind: o.kind,
          title: o.title,
          state: o.state,
          head_commit: o.head_commit,
          ...(o.last_submitted_head ? { last_submitted_head: o.last_submitted_head } : {}),
          pending_comments: o.pending_comments,
          updated_at: o.updated_at,
          last_used_at: o.last_used_at,
        };
      });
    },
    openReview: async (pid, input) => {
      await delay();
      const { rec, reviews } = project(pid);
      if (input.source === "local" || (!input.pr && !input.url)) {
        const source = `local:${input.base ?? "main"}..${input.head ?? "HEAD"}`;
        const existing = [...reviews.values()].find((r) => r.review.source === source);
        if (existing) return reviewOut(existing);
        const r = build(rec, source, null, input);
        reviews.set(r.review.id, r);
        return reviewOut(r);
      }
      if (k.nogh || k.notloggedin) throw err(409, k.nogh ? "gh_not_installed" : "not_logged_in", "pull requests cannot be opened without the GitHub CLI");
      const number = input.pr ?? Number(/\/pull\/(\d+)/.exec(input.url ?? "")?.[1]);
      if (input.url && !input.url.includes(DEMO_REPO)) throw err(400, "repo_mismatch", `that address is not a pull request of ${DEMO_REPO}`);
      const spec = PULLS.find((p) => p.row.number === number);
      if (!spec) throw err(404, "not_found", `pull request #${number} was not found on ${DEMO_REPO}`);
      const source = `github:${DEMO_REPO}#${number}`;
      const existing = [...reviews.values()].find((r) => r.review.source === source);
      if (existing) return reviewOut(existing);
      const r = build(rec, source, spec, input);
      reviews.set(r.review.id, r);
      return reviewOut(r);
    },
    getReview: async (pid, id) => (await delay(), reviewOut(find(pid, id))),
    patchReview: async (pid, id, patch) => {
      await delay();
      const r = find(pid, id);
      if (patch.state) r.review.state = patch.state;
      if (patch.refresh) r.review.meta = { ...r.review.meta, refreshed_at: iso() };
      return reviewOut(r);
    },
    listReviewFiles: async (pid, id): Promise<ReviewFiles> => {
      await delay();
      const r = find(pid, id);
      const o = reviewOut(r);
      return {
        base_commit: o.base_commit,
        head_commit: o.head_commit,
        files: fileList(r),
        totals: o.totals,
        viewed_count: o.viewed_count,
        large_pr: o.large_pr,
        ...(o.last_submitted_head ? { last_submitted_head: o.last_submitted_head } : {}),
      };
    },
    getReviewFileDiff: async (pid, id, path, options): Promise<ReviewFileDiff> => {
      await delay();
      const r = find(pid, id);
      const i = r.files.findIndex((f) => f.path === path);
      const f = r.files[i];
      if (!f) throw err(404, "path_not_in_diff", `${path} is not part of this review`);
      const context = Math.min(1000, options?.context ?? 3);
      const hunks = diffFor(f, context, options?.ignoreWhitespace === true);
      const big = f.tooLarge !== undefined || hunks.reduce((n, h) => n + h.lines.length, 0) > TOO_LARGE_LINES;
      return {
        ...fileOut(r, f, i),
        hunks: big ? [] : hunks,
        too_large: big,
        whitespace_ignored: options?.ignoreWhitespace === true,
        context,
        ...(options?.since ? { since: options.since } : {}),
      };
    },
    reviewFileRawUrl: (_pid, _id, _path, side) => pictureUrl(side),
    setReviewFileViewed: async (pid, id, path, viewed) => {
      await delay();
      const r = find(pid, id);
      const i = r.files.findIndex((f) => f.path === path);
      if (i < 0) throw err(404, "path_not_in_diff", `${path} is not part of this review`);
      if (viewed) r.viewed.add(path);
      else r.viewed.delete(path);
      r.changedSinceViewed.delete(path);
      return fileOut(r, r.files[i] as DemoReviewFile, i);
    },
    listReviewComments: async (pid, id) => (await delay(), structuredClone(find(pid, id).comments)),
    createReviewComment: async (pid, id, input) => {
      await delay();
      const r = find(pid, id);
      if (r.review.state === "closed") throw err(409, "review_closed", "this review is closed");
      if (!input.body.trim()) throw err(400, "empty_comment", "a comment needs text");
      if (input.path) {
        const f = r.files.find((x) => x.path === input.path);
        if (!f) throw err(400, "path_not_in_diff", `${input.path} is not part of this review`);
        if (input.line !== undefined) {
          const side = input.side ?? "new";
          const hunks = diffFor(f, 3, false);
          const [a, b] = [input.start_line ?? input.line, input.line];
          const ok = commentableRuns(hunks, side).some((run) => a >= run.start && b <= run.end);
          if (!ok) throw err(400, "line_not_in_diff", `line ${b} of ${input.path} is not in the diff`);
        }
      }
      const c = mkComment(r, input);
      r.comments.push(c);
      return structuredClone(c);
    },
    updateReviewComment: async (pid, id, cid, patch) => {
      await delay();
      const c = find(pid, id).comments.find((x) => x.id === cid);
      if (!c) throw err(404, "not_found", "comment not found");
      if (c.state === "submitted") throw err(409, "comment_submitted", "that comment was already posted");
      if (patch.body !== undefined) c.body = patch.body;
      if (patch.suggestion !== undefined) c.suggestion = patch.suggestion;
      c.updated_at = iso();
      return structuredClone(c);
    },
    deleteReviewComment: async (pid, id, cid) => {
      await delay();
      const r = find(pid, id);
      const c = r.comments.find((x) => x.id === cid);
      if (!c) throw err(404, "not_found", "comment not found");
      if (c.state === "submitted") throw err(409, "comment_submitted", "that comment was already posted");
      r.comments = r.comments.filter((x) => x.id !== cid);
    },
    listReviewFindings: async (pid, id) => (await delay(), structuredClone(find(pid, id).findings)),
    decideReviewFinding: async (pid, id, fid, d) => {
      await delay();
      const r = find(pid, id);
      const f = r.findings.find((x) => x.id === fid);
      if (!f) throw err(404, "not_found", "finding not found");
      f.status = d.status;
      f.updated_at = iso();
      if (d.reason !== undefined) f.dismiss_reason = d.reason;
      r.comments = r.comments.filter((c) => c.finding_id !== fid || c.state === "submitted");
      let comment: ReviewComment | undefined;
      if (d.status === "kept") {
        comment = mkComment(r, { path: f.path, side: "new", line: f.end_line, start_line: f.start_line, body: d.body ?? f.statement, finding_id: f.id });
        r.comments.push(comment);
      }
      return { finding: structuredClone(f), ...(comment ? { comment: structuredClone(comment) } : {}) };
    },
    previewReviewSubmit: async (pid, id, input) => (await delay(), structuredClone(previewOf(find(pid, id), input))),
    submitReview: async (pid, id, input) => {
      await delay();
      const r = find(pid, id);
      const verdict: ReviewVerdict = input.verdict;
      const now = pending(r);
      if (input.comment_ids && (input.comment_ids.length !== now.length || input.comment_ids.some((c) => !now.some((x) => x.id === c))))
        throw err(409, "comments_changed", "the pending comments changed since the preview");
      if (now.length === 0 && !input.body?.trim() && verdict !== "approve") throw err(400, "empty_review", "there is nothing to post");
      const github = r.review.kind === "github";
      if (github && k.submitlogin && !r.failedOnce) {
        r.failedOnce = true;
        throw err(409, "not_logged_in", "gh is not logged in");
      }
      if (github && k.fail && !r.failedOnce) {
        r.failedOnce = true;
        throw err(502, "code_host_error", "GitHub answered 422: Unprocessable Entity (pull_request_review_thread.line must be part of the diff)");
      }
      const preview = previewOf(r, input);
      for (const c of now) {
        c.state = "submitted";
        c.submission_id = "sub_1";
        c.submitted_at = iso();
      }
      r.review.last_submitted_head = r.review.head_commit;
      r.review.last_submitted_at = iso();
      r.changedSinceSubmitted.clear();
      return {
        ...preview,
        posted: github,
        submission_id: newId("sub"),
        ...(github ? { url: `https://${DEMO_HOST}/${DEMO_REPO}/pull/${r.review.number}#pullrequestreview-9001` } : {}),
        review: reviewOut(r),
      };
    },
  };
}
