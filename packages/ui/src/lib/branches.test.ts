import assert from "node:assert/strict";
import test from "node:test";
import type { BranchesResult, GitBranch, RepoBranches } from "@octo/agent-client";
import { branchLabel, branchSections, branchTitle, looksLikeBranchName, mergePage } from "./branches";

const b = (name: string, current = false): GitBranch => ({
  name,
  current,
  ahead: 0,
  behind: 0,
  commit: { sha: name, subject: `on ${name}`, date: "2026-11-19T08:00:00Z" },
});

const repo = (over: Partial<RepoBranches> = {}): RepoBranches => ({
  folder_id: "fld_1",
  folder: "app",
  folders: ["app"],
  repo_root: "/src/app",
  repo_name: "app",
  branch: "main",
  detached: false,
  head: "9c1e2f3",
  dirty_files: 0,
  branches: [b("main", true), b("fix-login"), b("feature/export")],
  total: 3,
  ...over,
});

const result = (...repos: RepoBranches[]): BranchesResult => ({ workspace: "shared", running_sessions: 0, repos });

test("the chip names the branch, else the detached commit, and the tooltip says which checkout", () => {
  assert.equal(branchLabel(repo()), "main");
  assert.equal(branchLabel(repo({ branch: "", detached: true })), "9c1e2f3");
  assert.equal(branchTitle(repo(), "shared"), "main — main checkout");
  assert.equal(branchTitle(repo({ branch: "fix-login" }), "worktree"), "fix-login — worktree");
  assert.equal(branchTitle(repo({ branch: "", detached: true }), "shared"), "9c1e2f3 (detached) — main checkout");
});

test("one repository: one untitled section, current first and checked, then the worktree section", () => {
  const s = branchSections(result(repo()), "", { worktree: true });
  assert.deepEqual(
    s.map((x) => x.title),
    ["", "In a new worktree"],
  );
  const first = s[0]?.rows ?? [];
  assert.deepEqual(
    first.map((r) => (r.kind === "branch" ? `${r.name}${r.current ? "*" : ""}` : r.kind)),
    ["main*", "fix-login", "feature/export"],
  );
  assert.deepEqual(
    s[1]?.rows.map((r) => (r.kind === "worktree" ? r.name : r.kind)),
    ["main", "fix-login", "feature/export"],
  );
});

test("a query narrows the rows and offers to create a branch no row is called", () => {
  const s = branchSections(result(repo()), "fix", { worktree: false });
  assert.deepEqual(
    s[0]?.rows.map((r) => r.kind + ":" + ("name" in r ? r.name : "")),
    ["branch:fix-login", "create:fix"],
  );
  const create = s[0]?.rows.find((r) => r.kind === "create");
  assert.equal(create?.kind === "create" ? create.from : "", "main");
  // An exact name offers no create row; a name git would refuse neither.
  assert.ok(!branchSections(result(repo()), "fix-login", { worktree: false })[0]?.rows.some((r) => r.kind === "create"));
  assert.ok(!branchSections(result(repo()), "a b", { worktree: false }).some((x) => x.rows.some((r) => r.kind === "create")));
});

test("several repositories: one titled section each; create and worktree rows only for the first", () => {
  const web = repo({ folder_id: "fld_2", folder: "web", repo_name: "web", branch: "develop", branches: [b("develop", true), b("main")], total: 2 });
  const s = branchSections(result(repo(), web), "", { worktree: true });
  assert.deepEqual(
    s.map((x) => x.title),
    ["app · main", "web · develop", "In a new worktree"],
  );
  const created = branchSections(result(repo(), web), "spike", { worktree: true });
  assert.equal(created.flatMap((x) => x.rows).filter((r) => r.kind === "create").length, 1);
  assert.equal(created[0]?.rows.at(-1)?.kind, "create");
});

test("a repository with more branches than loaded ends with a 'more' row", () => {
  const s = branchSections(result(repo({ total: 40, next_offset: 3 })), "", { worktree: false });
  const last = s[0]?.rows.at(-1);
  assert.equal(last?.kind, "more");
  assert.equal(last?.kind === "more" ? last.remaining : 0, 37);
});

test("mergePage appends the next chunk without repeating a branch", () => {
  const next = repo({ branches: [b("feature/export"), b("chore/deps")], total: 5, next_offset: 5 });
  const merged = mergePage(repo({ total: 5, next_offset: 3 }), next);
  assert.deepEqual(
    merged.branches.map((x) => x.name),
    ["main", "fix-login", "feature/export", "chore/deps"],
  );
  assert.equal(merged.next_offset, 5);
  const done = mergePage(merged, repo({ branches: [b("last")], total: 5 }));
  assert.equal(done.next_offset, undefined);
});

test("looksLikeBranchName follows git's rules for a new branch", () => {
  for (const ok of ["fix", "feature/x", "release-2.4", "a_b"]) assert.ok(looksLikeBranchName(ok), ok);
  for (const bad of ["", " ", "a b", "-x", "a..b", "x.lock", "x/", "/x", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "@", "a@{b"]) {
    assert.ok(!looksLikeBranchName(bad), bad);
  }
});
