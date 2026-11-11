import assert from "node:assert/strict";
import test from "node:test";
import { chosenFrom, completion, folderName, looksLikePath, mergeRecent, parentOf, rememberFolder } from "./folderPick";

test("looksLikePath", () => {
  assert.ok(looksLikePath("/Users"));
  assert.ok(looksLikePath("~/code"));
  assert.ok(looksLikePath("C:\\\\work"));
  assert.ok(!looksLikePath("atlas"));
  assert.ok(!looksLikePath(""));
});

test("parentOf and folderName", () => {
  assert.equal(parentOf("/Users/maya/code/atlas"), "/Users/maya/code");
  assert.equal(parentOf("/Users/maya/code/atlas/"), "/Users/maya/code");
  assert.equal(parentOf("/x"), "");
  assert.equal(folderName("/Users/maya/code/atlas/"), "atlas");
  assert.equal(folderName("atlas"), "atlas");
});

test("mergeRecent: chosen first, then the harness's, once each, at most 8", () => {
  const h = [
    { name: "atlas", path: "/a/atlas", git: { branch: "main" } },
    { name: "docs", path: "/a/docs", git: null },
  ];
  const out = mergeRecent(["/a/docs/", "/b/new"], h);
  assert.deepEqual(
    out.map((e) => e.path),
    ["/a/docs/", "/b/new", "/a/atlas"],
  );
  assert.equal(
    mergeRecent(
      Array.from({ length: 12 }, (_, i) => `/p${i}`),
      h,
    ).length,
    8,
  );
  assert.equal(out[2]?.git?.branch, "main");
});

test("remember, stored list and completion", () => {
  assert.deepEqual(rememberFolder(["/a", "/b"], "/b"), ["/b", "/a"]);
  assert.deepEqual(chosenFrom(["/a", 3, ""]), ["/a"]);
  assert.deepEqual(chosenFrom(null), []);
  assert.equal(completion("/Users/maya"), "/Users/maya/");
  assert.equal(completion("/Users/"), "/Users/");
});
