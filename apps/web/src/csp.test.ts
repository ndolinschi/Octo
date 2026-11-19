import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The <meta> policy of the web build is the header the harness sends (apps/harness/internal/remoteaccess/static.go).
test("the web build's CSP is the harness's", () => {
  const go = readFileSync(new URL("../../harness/internal/remoteaccess/static.go", import.meta.url), "utf8");
  const header = /const CSP = ((?:"[^"]*"(?: \+\s*)?)+)/.exec(go)?.[1];
  assert.ok(header, "CSP constant not found in static.go");
  const fromGo = [...header.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  const meta = /const WEB_CSP =\s*((?:"[^"]*"(?: \+\s*)?)+);/.exec(vite)?.[1];
  assert.ok(meta, "WEB_CSP not found in vite.config.ts");
  const fromVite = [...meta.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  assert.equal(fromVite, fromGo);
});
