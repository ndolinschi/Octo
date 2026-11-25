import assert from "node:assert/strict";
import test from "node:test";
import type { FileEntry } from "@octo/agent-client";
import { compactChain, isSourceRoot, MAX_CHAIN, underSourceRoot } from "./compactFolders";

const dir = (path: string, chain?: string[]): FileEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  type: "dir",
  size: 0,
  ...(chain ? { chain } : {}),
});
const file = (path: string): FileEntry => ({ name: path.split("/").at(-1) ?? path, path, type: "file", size: 1 });

/** A lookup over a fake loaded tree: only the listed directories are "loaded". */
const loaded = (listings: Record<string, FileEntry[]>) => (path: string) => listings[path];
const none = () => undefined;

const PKG = ["com", "wsgc", "ecommerce", "product", "configurator", "management", "data", "subsystem"];

test("source roots: a JVM language directory two below src", () => {
  assert.equal(isSourceRoot("app/src/main/java"), true);
  assert.equal(isSourceRoot("src/test/kotlin"), true);
  assert.equal(isSourceRoot("src/integration/scala"), true);
  assert.equal(isSourceRoot("src/main/groovy"), true);
  assert.equal(isSourceRoot("src/main/resources"), false);
  assert.equal(isSourceRoot("main/java"), false);
  assert.equal(isSourceRoot("lib/main/java"), false);
  assert.equal(isSourceRoot("src/java"), false);
  assert.equal(underSourceRoot("app/src/main/java"), true);
  assert.equal(underSourceRoot("app/src/main/java/com/acme"), true);
  assert.equal(underSourceRoot("app/src/main"), false);
  assert.equal(underSourceRoot(""), false);
});

test("the screenshot: src/main/java is one row, the package another", () => {
  const src = dir("app/src", ["main", "java", ...PKG]);
  const row = compactChain(src, none);
  assert.deepEqual(row.segments, ["src", "main", "java"]);
  assert.equal(row.label, "src/main/java");
  assert.deepEqual(row.paths, ["app/src", "app/src/main", "app/src/main/java"]);
  assert.equal(row.last, "app/src/main/java");

  // java's own listing (one request for the row) carries com's chain.
  const com = dir("app/src/main/java/com", PKG.slice(1));
  const pkg = compactChain(com, none);
  assert.equal(pkg.label, "com.wsgc.ecommerce.product.configurator.management.data.subsystem");
  assert.equal(pkg.separator, ".");
  assert.equal(pkg.last, `app/src/main/java/${PKG.join("/")}`);
});

test("a directory with no chain is a row of one", () => {
  const row = compactChain(dir("app/config"), none);
  assert.deepEqual(row.segments, ["config"]);
  assert.equal(row.label, "config");
  assert.equal(row.last, "app/config");
});

test("a file mid-chain ends it at that directory (loaded listings win over the hint)", () => {
  // The hint is stale: ecommerce now holds a file too.
  const com = dir("j/src/main/java/com", PKG.slice(1));
  const row = compactChain(
    com,
    loaded({
      "j/src/main/java/com/wsgc/ecommerce": [
        dir("j/src/main/java/com/wsgc/ecommerce/product", PKG.slice(4)),
        file("j/src/main/java/com/wsgc/ecommerce/Notes.java"),
      ],
    }),
  );
  assert.equal(row.label, "com.wsgc.ecommerce");
  assert.equal(row.last, "j/src/main/java/com/wsgc/ecommerce");
});

test("two child directories end the chain", () => {
  const row = compactChain(dir("a"), loaded({ a: [dir("a/b"), dir("a/c")] }));
  assert.equal(row.label, "a");
});

test("a loaded single child continues with that child's own hint", () => {
  const row = compactChain(dir("a", ["stale"]), loaded({ a: [dir("a/b", ["c", "d"])] }));
  assert.equal(row.label, "a/b/c/d");
});

test("an empty directory is a row of one; a chain may end in an empty leaf", () => {
  assert.equal(compactChain(dir("empty"), loaded({ empty: [] })).label, "empty");
  const row = compactChain(dir("lone", ["leaf"]), none);
  assert.equal(row.label, "lone/leaf");
  assert.equal(row.last, "lone/leaf");
});

test("a source root heading its own row stops there; its children are packages", () => {
  const java = compactChain(dir("src/main/java", ["com", "acme"]), none);
  assert.equal(java.label, "java");
  const com = compactChain(dir("src/main/java/com", ["acme"]), none);
  assert.equal(com.label, "com.acme");
});

test("outside a source root the separator is a slash", () => {
  const row = compactChain(dir("docs", ["guides", "intro"]), none);
  assert.equal(row.separator, "/");
  assert.equal(row.label, "docs/guides/intro");
  const res = compactChain(dir("src/main/resources", ["com", "acme"]), none);
  assert.equal(res.label, "resources/com/acme");
});

test("names containing dots are joined with a slash even in a package", () => {
  const row = compactChain(dir("src/main/java/com", ["acme.v2", "core"]), none);
  assert.equal(row.separator, "/");
  assert.equal(row.label, "com/acme.v2/core");
  const plain = compactChain(dir("site", ["v1.2", "assets"]), none);
  assert.equal(plain.label, "site/v1.2/assets");
});

test("a deep chain stops at the cap; the rest is the next row", () => {
  const names = Array.from({ length: 50 }, (_, i) => `d${i}`);
  const row = compactChain(dir("top", names), none);
  assert.equal(row.segments.length, MAX_CHAIN + 1);
  assert.equal(row.segments.at(-1), `d${MAX_CHAIN - 1}`);
  const deep = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => {
      const p = ["x", ...names.slice(0, i)].join("/");
      return [p, [dir(`${p}/d${i}`)]];
    }),
  );
  assert.equal(compactChain(dir("x"), loaded(deep)).segments.length, MAX_CHAIN + 1);
});
