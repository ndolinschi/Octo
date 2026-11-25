import assert from "node:assert/strict";
import test from "node:test";
import { alwaysAnswer, alwaysLabel, canAlwaysAllow, describeRule, ruleError, ruleLine } from "./rules";

test("a prefix rule says it covers what starts with it; an exact one only itself", () => {
  const prefix = describeRule({ tool: "bash", match: "git status", exact: false });
  assert.equal(prefix.code, "git status");
  assert.match(prefix.sentence, /starts with/);
  assert.match(describeRule({ tool: "bash", match: "npx tsc -b", exact: true }).sentence, /exact/);
});

test("path and host rules", () => {
  assert.equal(describeRule({ tool: "edit", match: "src/a.ts", exact: true }).subject, "Path");
  assert.equal(describeRule({ tool: "web_fetch", match: "docs.example.com", exact: false }).subject, "Host");
  assert.equal(alwaysLabel({ tool: "web_fetch", match: "x", exact: false }), "Always allow this host");
  assert.equal(alwaysLabel({ tool: "write_file", match: "x", exact: true }), "Always allow this path");
  assert.equal(alwaysLabel({ tool: "bash", match: "x", exact: false }), "Always allow this command");
});

test("only an approval with a suggested rule can be always-allowed", () => {
  assert.equal(canAlwaysAllow({}), false);
  assert.equal(canAlwaysAllow({ suggested_rule: { tool: "bash", match: "  ", exact: true } }), false);
  assert.equal(canAlwaysAllow({ suggested_rule: { tool: "bash", match: "ls", exact: false } }), true);
  assert.deepEqual(alwaysAnswer(), { decision: "allow_always" });
});

test("list line and errors", () => {
  assert.equal(ruleLine({ tool: "bash", match: "pnpm test", exact: false }), "Command: pnpm test (this command and anything that starts with it)");
  assert.match(ruleError("no_rule") ?? "", /once/);
  assert.equal(ruleError("x"), null);
});
