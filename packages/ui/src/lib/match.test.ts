import assert from "node:assert/strict";
import test from "node:test";
import { matchKind, matchScore, rankGroups } from "./match";

test("an empty query matches everything with the same score", () => {
  assert.equal(matchScore("", "anything"), 0);
  assert.equal(matchScore("   ", "anything"), 0);
});

test("no match is -1", () => {
  assert.equal(matchScore("xyz", "refresh token"), -1);
  assert.equal(matchScore("ba", "ab"), -1, "letters must come in order");
  assert.equal(matchScore("abc", ""), -1);
});

test("matching ignores case", () => {
  assert.ok(matchScore("README", "readme.md") > 0);
  assert.ok(matchScore("readme", "README.md") > 0);
});

test("an earlier substring outranks a later one", () => {
  assert.ok(matchScore("tok", "tokens.ts") > matchScore("tok", "a/b/c/xtokens.ts"));
  assert.ok(matchScore("a", "abc") > matchScore("c", "abc"));
});

test("a word-start match outranks a mid-word match at the same position", () => {
  for (const sep of [" ", "-", "_", "/", ".", ":", "("]) {
    assert.ok(matchScore("ref", `x${sep}refresh`) > matchScore("ref", "xxrefresh"), JSON.stringify(sep));
  }
});

test("a substring outranks a fuzzy match, and tighter fuzzy beats looser fuzzy", () => {
  const substring = matchScore("auth", "src/auth/refresh.ts");
  const fuzzy = matchScore("auth", "a_u_t_h");
  assert.ok(substring > fuzzy && fuzzy > 0);
  assert.ok(matchScore("abc", "a-b-c") > matchScore("abc", "a------b------c"));
});

test("spaces in the query are skipped when matching fuzzily, never negative for a far match", () => {
  assert.ok(matchScore("s r", "src/refresh.ts") > 0);
  assert.equal(matchScore("a", "x".repeat(2000) + "a"), 1000 - 500, "position penalty is capped");
  assert.ok(matchScore("az", "a" + "x".repeat(2000) + "z") >= 1, "the score floors at 1");
});

test("unicode", () => {
  assert.ok(matchScore("日本", "docs/日本語.md") > 0);
  assert.equal(matchScore("é", "cafe"), -1);
});

test("match kinds: word start, inside a word, loose", () => {
  assert.equal(matchKind("integr", "Open integrations"), "word");
  assert.equal(matchKind("open", "Open integrations"), "word");
  assert.equal(matchKind("tegr", "Open integrations"), "inside");
  assert.equal(matchKind("integr", "Infrastructure: Terraform modules for staging and production clusters"), "fuzzy");
  assert.equal(matchKind("zzz", "Open integrations"), null);
});

test("groups: a word-start action outranks a project that matches loosely; ties keep order", () => {
  const groups = [
    { title: "Projects", labels: ["Infrastructure: Terraform modules for staging and production clusters", "Atlas API"] },
    { title: "Actions", labels: ["Open settings", "Open integrations"] },
  ];
  assert.deepEqual(
    rankGroups("integr", groups, (g) => g.labels).map((g) => g.title),
    ["Actions", "Projects"],
  );
  assert.deepEqual(
    rankGroups("atlas", groups, (g) => g.labels).map((g) => g.title),
    ["Projects", "Actions"],
  );
  assert.deepEqual(
    rankGroups("", groups, (g) => g.labels).map((g) => g.title),
    ["Projects", "Actions"],
  );
});
