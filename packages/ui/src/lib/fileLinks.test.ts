import assert from "node:assert/strict";
import test from "node:test";
import { fileLookup, looksLikePath, resolveFileRef } from "./fileLinks";

const files = [
  { folder: "atlas-api", path: "src/auth/refresh.ts" },
  { folder: "atlas-web", path: "src/lib/session.ts" },
  { folder: "atlas-api", path: "README.md" },
  { folder: "atlas-web", path: "README.md" },
];
const lookup = fileLookup(files);

test("folder/path and paths unique under one folder resolve", () => {
  assert.deepEqual(resolveFileRef("atlas-api/src/auth/refresh.ts", lookup), { folder: "atlas-api", path: "src/auth/refresh.ts" });
  assert.deepEqual(resolveFileRef("src/lib/session.ts", lookup), { folder: "atlas-web", path: "src/lib/session.ts" });
});

test("line and range suffixes", () => {
  assert.deepEqual(resolveFileRef("src/auth/refresh.ts:12", lookup), { folder: "atlas-api", path: "src/auth/refresh.ts", start: 12 });
  assert.deepEqual(resolveFileRef("atlas-api/src/auth/refresh.ts:12-20", lookup), { folder: "atlas-api", path: "src/auth/refresh.ts", start: 12, end: 20 });
});

test("ambiguous or unknown code stays plain", () => {
  assert.equal(resolveFileRef("README.md", lookup), null);
  assert.equal(resolveFileRef("src/nope.ts", lookup), null);
  assert.equal(resolveFileRef("refresh_reused", lookup), null);
});

test("path-like detection", () => {
  assert.ok(looksLikePath("src/a.ts:3"));
  assert.ok(looksLikePath("README.md"));
  assert.ok(!looksLikePath("401"));
  assert.ok(!looksLikePath("BroadcastChannel"));
  assert.ok(!looksLikePath("https://x.dev/a"));
});

test("the lookup is shared per list", () => {
  assert.equal(fileLookup(files), lookup);
});
