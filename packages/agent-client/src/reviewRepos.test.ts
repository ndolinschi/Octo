import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type FetchLike } from "./client";
import { ALL_REPOSITORIES, refusalRepoChoices, repoMenu, type RepoRef } from "./review";

function bridgeWith(status: number, body: string) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(`${init?.method} ${url.replace("http://h:1", "")}`);
    return { ok: status < 400, status, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1/", fetch }), urls };
}

const fork: RepoRef = { host: "github", hostname: "github.com", repo: "eCommerce-Ebro/shop", remote: "origin", role: "origin", default: true };
const parent: RepoRef = { host: "github", hostname: "github.com", repo: "eCommerce-Bedrock/shop", role: "parent", default: false };
const upstream: RepoRef = { host: "github", repo: "x/y", remote: "upstream", role: "upstream", default: false };
const other: RepoRef = { host: "github", repo: "z/w", remote: "fork2", role: "other", default: false };

test("listPullRequests sends repo; listReviewBranches hits its route", async () => {
  const { bridge, urls } = bridgeWith(200, '{"prs":[],"branches":[]}');
  await bridge.listPullRequests?.("p", { repo: "eCommerce-Bedrock/shop" });
  await bridge.listPullRequests?.("p", { folder: "f", repo: "all" });
  await bridge.listReviewBranches?.("p");
  await bridge.listReviewBranches?.("p", { folder: "my repo", base: "release/1" });
  await bridge.openReview?.("p", { pr: 3, repo: "a/b" });
  assert.deepEqual(urls, [
    "GET /v1/projects/p/prs?repo=eCommerce-Bedrock%2Fshop",
    "GET /v1/projects/p/prs?folder=f&repo=all",
    "GET /v1/projects/p/review/branches",
    "GET /v1/projects/p/review/branches?folder=my%20repo&base=release%2F1",
    "POST /v1/projects/p/reviews",
  ]);
});

test("a repository refusal carries the folder's repositories", async () => {
  const body = JSON.stringify({ error: { code: "repo_mismatch", message: "nope", repos: [fork, parent] } });
  const { bridge } = bridgeWith(400, body);
  await assert.rejects(bridge.openReview?.("p", { url: "https://github.com/o/r/pull/1" }) as Promise<unknown>, (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "repo_mismatch");
    assert.deepEqual(e.repos, [fork, parent]);
    assert.deepEqual(refusalRepoChoices(e), [
      { key: "eCommerce-Ebro/shop", label: "eCommerce-Ebro/shop", detail: "origin" },
      { key: "eCommerce-Bedrock/shop", label: "eCommerce-Bedrock/shop", detail: "parent" },
    ]);
    return true;
  });
  assert.deepEqual(refusalRepoChoices({ code: "not_found", repos: [fork] }), []);
});

test("repoMenu: no menu for one repository", () => {
  const m = repoMenu({ repo: fork.repo, repos: [fork] });
  assert.equal(m.show, false);
  assert.equal(m.current, "eCommerce-Ebro/shop");
  assert.deepEqual(
    m.items.map((i) => i.label),
    ["eCommerce-Ebro/shop"],
  );
  assert.equal(m.rowsShowRepo, false);
  assert.equal(repoMenu({}).show, false);
});

test("repoMenu: owner/name with the role dim, All repositories last", () => {
  const m = repoMenu({ repo: parent.repo, repos: [fork, parent, upstream, other] });
  assert.equal(m.show, true);
  assert.equal(m.current, "eCommerce-Bedrock/shop");
  assert.deepEqual(
    m.items.map((i) => [i.key, i.label, i.detail, i.selected]),
    [
      ["eCommerce-Ebro/shop", "eCommerce-Ebro/shop", "origin", false],
      ["eCommerce-Bedrock/shop", "eCommerce-Bedrock/shop", "parent", true],
      ["x/y", "x/y", "upstream", false],
      ["z/w", "z/w", "fork2", false],
      ["all", ALL_REPOSITORIES, undefined, false],
    ],
  );
  assert.equal(m.rowsShowRepo, false);
});

test("repoMenu: All repositories selected shows the repository on rows; no repo means the default", () => {
  const all = repoMenu({ repo: "all", repos: [fork, parent] });
  assert.equal(all.current, "All repositories");
  assert.equal(all.rowsShowRepo, true);
  assert.deepEqual(
    all.items.map((i) => i.selected),
    [false, false, true],
  );
  const d = repoMenu({ repos: [fork, parent] });
  assert.equal(d.current, "eCommerce-Ebro/shop");
  assert.deepEqual(
    d.items.map((i) => i.selected),
    [true, false, false],
  );
});
