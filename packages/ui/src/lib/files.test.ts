import assert from "node:assert/strict";
import test from "node:test";
import { ancestors, fileKey, fileName, isRootKey, keyFolder, keyInFolder, normalizePath, parentPath, parseFileKey, resolveFolder, splitKey } from "./files";

test("file keys round trip, including the folder root and odd characters", () => {
  for (const [folder, path] of [
    ["web", "src/a.ts"],
    ["web", ""],
    ["my folder", "dir with space/日本.ts"],
    ["web", "a:b/c#d"],
  ] as const) {
    assert.deepEqual(splitKey(fileKey(folder, path)), { folder, path });
  }
  assert.notEqual(fileKey("a", "b/c"), fileKey("a/b", "c"), "folder and path cannot blur together");
});

test("normalizePath: relative, slash-separated, no ./ or trailing slash", () => {
  assert.equal(normalizePath("./src//a.ts"), "src/a.ts");
  assert.equal(normalizePath("src/a/"), "src/a");
  assert.equal(normalizePath("src\\win\\a.ts"), "src/win/a.ts");
  assert.equal(normalizePath("."), "");
  assert.equal(normalizePath(""), "");
  assert.equal(normalizePath("/abs/path"), "abs/path");
});

test("normalizePath resolves .. and never climbs above the folder", () => {
  assert.equal(normalizePath("a/b/../c"), "a/c");
  assert.equal(normalizePath("a/.."), "");
  assert.equal(normalizePath("../../etc/passwd"), "etc/passwd");
});

test("parentPath, fileName and ancestors", () => {
  assert.equal(parentPath("a/b/c.ts"), "a/b");
  assert.equal(parentPath("c.ts"), "");
  assert.equal(parentPath(""), "");
  assert.equal(fileName("a/b/c.ts"), "c.ts");
  assert.equal(fileName("c.ts"), "c.ts");
  assert.equal(fileName(""), "");
  assert.deepEqual(ancestors("a/b/c.ts"), ["", "a", "a/b"]);
  assert.deepEqual(ancestors("a"), [""]);
  assert.deepEqual(ancestors(""), []);
});

test("resolveFolder defaults to the first folder; an unknown label is null", () => {
  const folders = [{ label: "api" }, { label: "web" }];
  assert.equal(resolveFolder(folders, undefined), "api");
  assert.equal(resolveFolder(folders, "web"), "web");
  assert.equal(resolveFolder(folders, "nope"), null);
  assert.equal(resolveFolder([], undefined), null);
  assert.equal(resolveFolder([], "web"), null);
});

test("parseFileKey accepts only strings built by fileKey; foreign strings are rejected", () => {
  for (const [folder, path] of [
    ["web", "src/a.ts"],
    ["web", ""],
    ["日本", "a b/c#d"],
  ] as const) {
    const key = fileKey(folder, path);
    assert.equal(parseFileKey(key), key, "round trip");
    assert.deepEqual(splitKey(key), { folder, path });
  }
  for (const foreign of ["", "web/src/a.ts", "web:src", "chat", "file:web", "web\\src"]) assert.equal(parseFileKey(foreign), null, JSON.stringify(foreign));
});

test("key helpers: folder, root, membership", () => {
  const a = fileKey("web", "src/a.ts");
  const root = fileKey("web", "");
  assert.equal(keyFolder(a), "web");
  assert.equal(isRootKey(root), true);
  assert.equal(isRootKey(a), false);
  assert.equal(keyInFolder(a, "web"), true);
  assert.equal(keyInFolder(root, "web"), true, "the root belongs to its folder");
  assert.equal(keyInFolder(a, "we"), false, "a folder name that is a prefix of another does not match");
  assert.equal(keyInFolder(fileKey("web2", "x"), "web"), false);
  assert.equal(keyInFolder(a, "api"), false);
});
