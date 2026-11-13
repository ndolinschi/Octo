import {
  BridgeError,
  type Bridge,
  type DiffHunk,
  type ListPullRequestsParams,
  type OpenReviewInput,
  type PullRequestList,
  type PullRequestRow,
  type RepoRef,
  type Review,
  type ReviewCheckoutResult,
  type ReviewComment,
  type ReviewDirtyFile,
  type ReviewFile,
  type ReviewFileDiff,
  type ReviewFiles,
  type ReviewFinding,
  type ReviewSubmitInput,
  type ReviewThread,
  type ReviewSubmitPreview,
  type ReviewVerdict,
} from "@octo/agent-client";
import { commentableRuns } from "../lib/review/position";
import { visibleRows } from "../lib/review/pullList";
import { BRANCH_COMMITS, DEMO_FORK, DEMO_FORK_PRS, DEMO_HOST, DEMO_REPO, iso, type PullSpec } from "./reviewData";
import { ALL_PULLS as PULLS } from "./reviewMore";
import { seedThreads, threadsAnswer } from "./reviewThreads";
import { SMALL_FILES, type DemoReviewFile } from "./reviewFiles";
import { countLines, lineDiff, lineOf } from "./reviewDiff";
import { emit, newId, type ProjectRecord } from "./store";

const LATENCY_MS = 70;
const TOO_LARGE_LINES = 2000;
const delay = () => new Promise((r) => setTimeout(r, LATENCY_MS));
const err = (status: number, code: string, message: string, repos?: RepoRef[]) => new BridgeError(status, code, message, repos ? { repos } : undefined);

type Knobs = {
  nogh: boolean;
  notloggedin: boolean;
  empty: boolean;
  fail: boolean;
  submitlogin: boolean;
  replyfail: boolean;
  clean: boolean;
  slow: boolean;
  single: boolean;
};

/** `?review=nogh|notloggedin|empty|fail|single` (comma separated; `single`: one repository instead of the fork and its parent; `submitlogin` makes the first submit say not logged in). */
function knobs(): Knobs {
  const raw = typeof location === "undefined" ? "" : (new URLSearchParams(location.search).get("review") ?? "");
  const set = new Set(raw.split(",").map((s) => s.trim()));
  return {
    nogh: set.has("nogh"),
    notloggedin: set.has("notloggedin"),
    empty: set.has("empty"),
    fail: set.has("fail"),
    submitlogin: set.has("submitlogin"),
    replyfail: set.has("replyfail"),
    clean: set.has("clean"),
    slow: set.has("slow"),
    single: set.has("single"),
  };
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
  threads: ReviewThread[];
  failedOnce: boolean;
  replyFailedOnce: boolean;
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
    threads: r.threads.filter((t) => t.path === f.path).length,
    unresolved_threads: r.threads.filter((t) => t.path === f.path && !t.resolved).length,
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
  const all = pending(r);
  const comments = all.filter((c) => c.kind !== "reply");
  const replies = all.filter((c) => c.kind === "reply" && c.in_reply_to);
  const general = comments.filter((c) => !c.path).map((c) => c.body);
  const body = [input.body?.trim() ?? "", ...general].filter(Boolean).join("\n\n");
  const github = r.review.kind === "github";
  const event = { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" }[input.verdict];
  return {
    verdict: input.verdict,
    body,
    comments,
    ...(replies.length
      ? { replies: replies.map((c) => ({ comment_id: c.id, thread_id: c.in_reply_to ?? "", in_reply_to_comment: "9001", body: c.body })) }
      : {}),
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
const repoOfSource = (source: string) => (source.startsWith("github:") ? source.slice(7, source.indexOf("#")) : DEMO_REPO);
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
      threads: spec?.row.number === 482 ? seedThreads(files) : [],
      failedOnce: false,
      replyFailedOnce: false,
      review: {
        id: newId("rv"),
        source,
        kind: spec ? "github" : "local",
        folder: input.folder ?? folderLabel(rec),
        ...(spec ? { repo: repoOfSource(source), number: spec.row.number } : {}),
        title: spec ? spec.row.title : `Local branch ${input.head ?? "HEAD"}`,
        body: spec ? spec.body : "",
        ...(spec ? { author: spec.row.author, url: `https://${DEMO_HOST}/${repoOfSource(source)}/pull/${spec.row.number}` } : {}),
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

  /** The folder works with a fork (origin) and its parent (upstream, tracked: the default); `?review=single` has the parent only. */
  const repos: RepoRef[] = k.single
    ? [{ host: "github", hostname: DEMO_HOST, repo: DEMO_REPO, remote: "origin", role: "origin", default: true }]
    : [
        { host: "github", hostname: DEMO_HOST, repo: DEMO_FORK, remote: "origin", role: "origin", default: false },
        { host: "github", hostname: DEMO_HOST, repo: DEMO_REPO, remote: "upstream", role: "upstream", default: true },
      ];
  const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  /** `repo` of a request: undefined is the default repository, "all" every one; anything else must be one of the folder's. */
  const resolveRepo = (raw: string | undefined): string => {
    if (!raw) return repos.find((r) => r.default)?.repo ?? DEMO_REPO;
    if (raw === "all") return "all";
    const hit = repos.find((r) => sameRepo(r.repo, raw));
    if (!hit) throw err(400, "invalid_repo", `${raw} is not a repository of this folder`, repos);
    return hit.repo;
  };
  const rowsOf = (pid: string, repo: string): PullRequestRow[] => {
    const parent = rows(pid).map((r) => ({ ...r, repo: DEMO_REPO }));
    const fork = parent
      .slice(0, DEMO_FORK_PRS)
      .map((r) => ({ ...r, repo: DEMO_FORK, url: r.url.replace(DEMO_REPO, DEMO_FORK), review: null, title: `${r.title} (fork)` }));
    if (k.single) return parent;
    return repo === "all" ? [...parent, ...fork] : sameRepo(repo, DEMO_FORK) ? fork : parent;
  };

  const fetchedAt = new Map<string, number>();
  const STALE_AFTER_MS = 15_000;
  const first_ms = () => (k.slow ? 2500 : 600);

  /** Cache semantics of the harness (RV1.5): first call fetches, later ones answer at once and say `stale` while refreshing. */
  const list = async (pid: string, params?: ListPullRequestsParams): Promise<PullRequestList> => {
    await delay();
    const { rec } = project(pid);
    const repoKey = resolveRepo(params?.repo);
    const common = { host: DEMO_HOST, folder: folderLabel(rec), repos };
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
        repo: repoKey,
        available: false,
        reason: "not_logged_in",
        message: "gh is installed but you are not logged in to github.com.",
        command: "gh auth login",
        prs: [],
      };
    const key = `${pid}:${params?.folder ?? ""}:${repoKey}`;
    const known = fetchedAt.get(key);
    if (known === undefined || params?.refresh) {
      await new Promise((r) => setTimeout(r, first_ms()));
      fetchedAt.set(key, Date.now());
    }
    const at = fetchedAt.get(key) ?? Date.now();
    const stale = Date.now() - at > STALE_AFTER_MS;
    if (stale) {
      setTimeout(() => {
        fetchedAt.set(key, Date.now());
        emit(rec, { type: "review.list_updated", folder: folderLabel(rec) });
      }, 900);
    }
    const all = k.empty ? [] : rowsOf(pid, repoKey);
    const matching = visibleRows(all, params?.filter ?? "all", params?.q ?? "");
    const perPage = Math.min(100, params?.per_page ?? 30);
    const page = Math.max(1, params?.page ?? 1);
    const slice = matching.slice((page - 1) * perPage, page * perPage);
    return {
      ...common,
      repo: repoKey,
      available: true,
      filter: params?.filter ?? "all",
      page,
      per_page: perPage,
      total: matching.length,
      next_page: page * perPage < matching.length ? page + 1 : null,
      stale,
      fetched_at: new Date(at).toISOString(),
      prs: slice,
    };
  };

  const DIRTY: ReviewDirtyFile[] = [
    { path: "src/usage/limiter.ts", status: "modified", code: " M" },
    { path: "src/billing/client.ts", status: "modified", code: "M " },
    { path: "notes/scratch.md", status: "untracked", code: "??" },
    { path: "src/old/legacy.ts", status: "deleted", code: " D" },
  ];
  /** Per project: the branch the folder is on and whether the dirty files were accepted. */
  const folderState = new Map<string, { branch: string }>();

  return {
    ...base,
    listPullRequests: (pid, params) => list(pid, params),
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
      let repo = input.repo ? resolveRepo(input.repo) : null;
      if (input.url) {
        const named = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//.exec(input.url)?.[1];
        const hit = named ? repos.find((r) => sameRepo(r.repo, named)) : undefined;
        if (!hit) throw err(400, "repo_mismatch", `that address is not a pull request of ${repos.map((r) => r.repo).join(" or ")}`, repos);
        repo = hit.repo;
      }
      // A bare number that exists in the fork and in its parent: the harness asks which.
      if (!repo && !k.single && PULLS.slice(0, DEMO_FORK_PRS).some((p) => p.row.number === number))
        throw err(409, "ambiguous_pr", `pull request #${number} exists in ${repos.map((r) => r.repo).join(" and ")}`, repos);
      repo ??= resolveRepo(undefined);
      const spec = PULLS.find((p) => p.row.number === number);
      const inFork = PULLS.slice(0, DEMO_FORK_PRS).some((p) => p.row.number === number);
      if (!spec || (sameRepo(repo, DEMO_FORK) && !inFork)) throw err(404, "not_found", `pull request #${number} was not found on ${repo}`);
      const source = `github:${repo}#${number}`;
      const existing = [...reviews.values()].find((r) => r.review.source === source);
      if (existing) return reviewOut(existing);
      const r = build(rec, source, spec, input);
      reviews.set(r.review.id, r);
      return reviewOut(r);
    },
    listReviewBranches: async (_pid, params) => {
      await delay();
      const def = "main";
      const base = params?.base?.trim() || def;
      const at = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
      const rows = [
        {
          name: "mira/billing-retry",
          current: true,
          ahead: 4,
          behind: 1,
          commit: { sha: "9f3c2ab", subject: "Retry transient 5xx from the billing client", date: at(42) },
        },
        {
          name: "feature/export-csv",
          current: false,
          ahead: 7,
          behind: 12,
          commit: { sha: "41de88c", subject: "Export invoices as CSV with a streaming writer", date: at(60 * 26) },
        },
        {
          name: "fix/rounding",
          current: false,
          ahead: 1,
          behind: 3,
          commit: { sha: "a0b7731", subject: "Round half to even in money.ts", date: at(60 * 24 * 4) },
        },
        { name: "docs/billing", current: false, ahead: 0, behind: 20, commit: { sha: "c2e19d4", subject: "Describe the retry policy", date: at(60 * 24 * 9) } },
        {
          name: "main",
          current: false,
          ahead: 0,
          behind: 0,
          commit: { sha: "7be4a10", subject: "Merge pull request #481 from atlas-labs/lint", date: at(60 * 5) },
        },
      ];
      return { folder: params?.folder ?? "atlas-api", base, default_base: def, branches: rows.filter((r) => r.name !== base || r.current) };
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
      if (input.in_reply_to) {
        const t = r.threads.find((x) => x.id === input.in_reply_to);
        if (!t) throw err(400, "unknown_thread", "that thread is not on this pull request; refresh the threads and try again");
        const reply = { ...mkComment(r, { path: t.path, body: input.body }), kind: "reply" as const, in_reply_to: t.id };
        r.comments.push(reply);
        return structuredClone(reply);
      }
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
      const replyErrors: { comment_id: string; message: string }[] = [];
      for (const c of now) {
        if (c.kind === "reply") {
          if (k.replyfail && replyErrors.length === 0 && !r.replyFailedOnce) {
            r.replyFailedOnce = true;
            replyErrors.push({ comment_id: c.id, message: "GitHub answered 404: the thread was deleted on the pull request" });
            continue;
          }
          r.threads
            .find((t) => t.id === c.in_reply_to)
            ?.comments.push({ id: String(9500 + r.comments.length), author: "you", body: c.body, created_at: iso() });
        }
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
        ...(replyErrors.length ? { reply_errors: replyErrors } : {}),
      };
    },
    listReviewThreads: async (pid, id) => (await delay(), threadsAnswer(find(pid, id).threads, iso())),
    checkoutReview: async (pid, id, input): Promise<ReviewCheckoutResult> => {
      await delay();
      const r = find(pid, id);
      const { rec } = project(pid);
      if (r.review.state === "closed") throw err(409, "review_closed", "this review is closed");
      if (input.mode === "workspace") {
        const ws = { review_id: r.review.id, path: r.review.worktree_path, title: r.review.title };
        rec.project.review_workspace = ws;
        emit(rec, { type: "review.workspace", review_workspace: ws });
        return { mode: "workspace", workspace: ws };
      }
      const st = folderState.get(pid) ?? { branch: "main" };
      const branch = `review/${r.review.number ?? "local"}-${r.review.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 24)
        .replace(/-$/, "")}`;
      if (st.branch === branch)
        return { mode: "working_copy", folder: r.review.folder, branch, previous_branch: branch, commit: r.review.head_commit, already_on_branch: true };
      if (!input.confirm && !k.clean) throw new BridgeError(409, "dirty_working_copy", "the working copy has uncommitted changes", { files: DIRTY });
      folderState.set(pid, { branch });
      return { mode: "working_copy", folder: r.review.folder, branch, previous_branch: st.branch, commit: r.review.head_commit, created: true };
    },
    clearReviewWorkspace: async (pid) => {
      await delay();
      const { rec } = project(pid);
      rec.project.review_workspace = null;
      emit(rec, { type: "review.workspace", review_workspace: null });
    },
  };
}
