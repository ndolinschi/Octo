import type { BranchesResult, RepoBranches } from "@octo/agent-client";

/**
 * The composer's branch chip and picker (UI decision 98): what the chip says, and the picker's rows as data. The rows
 * become `PickerRow`s in `chat/BranchPicker`; nothing here touches React or the bridge.
 */

export type CheckoutKind = "shared" | "worktree";

/** The chip's text: the checked-out branch, else the detached commit. */
export function branchLabel(r: Pick<RepoBranches, "branch" | "head">): string {
  return r.branch || r.head || "no commits";
}

/** The chip's tooltip: which branch, of which checkout ("main — main checkout", "fix-login — worktree"). */
export function branchTitle(r: Pick<RepoBranches, "branch" | "head" | "detached">, kind: CheckoutKind): string {
  const what = r.branch ? r.branch : r.detached ? `${r.head} (detached)` : branchLabel(r);
  return `${what} — ${kind === "worktree" ? "worktree" : "main checkout"}`;
}

export type BranchRow =
  | { kind: "branch"; repo: RepoBranches; name: string; current: boolean; subject: string; date: string }
  | { kind: "create"; repo: RepoBranches; name: string; from: string }
  | { kind: "more"; repo: RepoBranches; remaining: number }
  | { kind: "worktree"; repo: RepoBranches; name: string };

export type BranchSection = { id: string; title: string; rows: BranchRow[] };

/** Rows in the "In a new worktree" section while nothing is typed (typing narrows it like the branches). */
export const WORKTREE_ROWS = 5;

const INVALID = /[\s~^:?*[\\]|\.\.|@\{|^[-/.]|[/.]$|\.lock$|\/\/|\/\./;
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Whether git would take `name` as a new branch (`git check-ref-format --branch`'s rules, roughly; the harness decides). */
export function looksLikeBranchName(name: string): boolean {
  return name !== "" && name !== "@" && !INVALID.test(name) && !hasControl(name);
}

const matches = (name: string, q: string) => q === "" || name.toLowerCase().includes(q.toLowerCase());

/**
 * The picker's sections: per repository its branches (current first and checked — the harness's order), a "more" row when
 * the repository has more than loaded, and for the first repository a "create" row when the query names no branch and an
 * "In a new worktree" section (worktree creation uses one start point for every repository, so only the first one's
 * branches are offered). One repository: its section has no title; several: "name · current".
 */
export function branchSections(result: BranchesResult, query: string, opts: { worktree: boolean }): BranchSection[] {
  const q = query.trim();
  const many = result.repos.length > 1;
  const out: BranchSection[] = result.repos.map((repo, i) => {
    const rows: BranchRow[] = repo.branches
      .filter((b) => matches(b.name, q))
      .map((b) => ({ kind: "branch", repo, name: b.name, current: b.current, subject: b.commit.subject, date: b.commit.date }));
    if (repo.next_offset !== undefined) rows.push({ kind: "more", repo, remaining: Math.max(0, repo.total - repo.branches.length) });
    if (i === 0 && q !== "" && looksLikeBranchName(q) && !repo.branches.some((b) => b.name === q)) {
      rows.push({ kind: "create", repo, name: q, from: branchLabel(repo) });
    }
    return { id: repo.folder_id, title: many ? `${repo.repo_name} · ${branchLabel(repo)}` : "", rows };
  });
  const first = result.repos[0];
  if (opts.worktree && first) {
    const names = first.branches.map((b) => b.name).filter((n) => matches(n, q));
    const rows: BranchRow[] = (q === "" ? names.slice(0, WORKTREE_ROWS) : names).map((name) => ({ kind: "worktree", repo: first, name }));
    if (rows.length) out.push({ id: "worktree", title: "In a new worktree", rows });
  }
  return out.filter((s) => s.rows.length > 0);
}

/** The next chunk of a repository's branches appended to what is loaded (a branch seen twice is kept once). */
export function mergePage(prev: RepoBranches, next: RepoBranches): RepoBranches {
  const seen = new Set(prev.branches.map((b) => b.name));
  const { next_offset: _old, ...rest } = prev;
  const merged: RepoBranches = { ...rest, branches: [...prev.branches, ...next.branches.filter((b) => !seen.has(b.name))], total: next.total };
  return next.next_offset === undefined ? merged : { ...merged, next_offset: next.next_offset };
}
