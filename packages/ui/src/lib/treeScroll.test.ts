import assert from "node:assert/strict";
import test from "node:test";
import { TreeScrollController } from "./treeScroll";

test("scrolls once when selectedKey renders and does not jump again on subfolder expansion", () => {
  const ctrl = new TreeScrollController();
  const mounted = new Set(["repo:src/main.ts"]);

  ctrl.sync(1, "repo:src/main.ts");
  assert.equal(
    ctrl.consume(1, "repo:src/main.ts", (k) => mounted.has(k)),
    "repo:src/main.ts",
  );

  // Subsequent subfolder expand/collapse updates rows without changing revealTick/selectedKey.
  ctrl.sync(1, "repo:src/main.ts");
  assert.equal(
    ctrl.consume(1, "repo:src/main.ts", (k) => mounted.has(k)),
    null,
  );
});

test("waits for async folder expansion when revealed file is not yet in rows", () => {
  const ctrl = new TreeScrollController();
  const mounted = new Set<string>();

  ctrl.sync(2, "repo:src/deep/file.ts");
  assert.equal(
    ctrl.consume(2, "repo:src/deep/file.ts", (k) => mounted.has(k)),
    null,
  );

  mounted.add("repo:src/deep/file.ts");
  assert.equal(
    ctrl.consume(2, "repo:src/deep/file.ts", (k) => mounted.has(k)),
    "repo:src/deep/file.ts",
  );
  assert.equal(
    ctrl.consume(2, "repo:src/deep/file.ts", (k) => mounted.has(k)),
    null,
  );
});

test("manual subfolder toggle cancels an unconsumed reveal scroll", () => {
  const ctrl = new TreeScrollController();
  ctrl.sync(3, "repo:src/deep/file.ts");
  ctrl.cancel();
  assert.equal(
    ctrl.consume(3, "repo:src/deep/file.ts", () => true),
    null,
  );
});
