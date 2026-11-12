import assert from "node:assert/strict";
import test from "node:test";
import { hostOf, patchCounts, patchLines } from "./patch";

const PATCH = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";

test("a unified diff splits into kinds", () => {
  const lines = patchLines(PATCH);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["meta", "meta", "hunk", "context", "del", "add"],
  );
  assert.deepEqual(patchCounts(lines), { added: 1, removed: 1 });
});

test("hosts", () => {
  assert.equal(hostOf("https://docs.example.com:8443/a?b=1"), "docs.example.com:8443");
  assert.equal(hostOf("not a url"), "not a url");
});
