import assert from "node:assert/strict";
import test from "node:test";
import { demoChain } from "./files";

const tree = (...paths: string[]) => new Map(paths.map((p) => [p, { content: "", mtime: "" }]));

test("demoChain mirrors the harness's `chain`: single-child directories, a file or a fork ends it", () => {
  const t = tree(
    "m/src/main/java/com/acme/core/A.java",
    "m/src/main/java/com/acme/core/b/B.java",
    "m/pom.xml",
    "x/.git/HEAD",
    "x/y/z.txt",
    "fork/a/1",
    "fork/b/2",
  );
  assert.deepEqual(demoChain(t, "m"), []);
  assert.deepEqual(demoChain(t, "m/src"), ["main", "java", "com", "acme", "core"]);
  assert.deepEqual(demoChain(t, "x"), ["y"]);
  assert.deepEqual(demoChain(t, "fork"), []);
});
