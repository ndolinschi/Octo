import assert from "node:assert/strict";
import test from "node:test";
import { isStructured, plainStructured, readable } from "./plain";

/** Words no person-facing string may carry (decision 94b): the harness and the demo say the same plain things. */
const FORBIDDEN = /\b(ACP|MCP|exit status|stderr|JSON-?RPC)\b/i;

test("a structured failure shows its message and hint, and keeps details apart", () => {
  const f = {
    message: "GitHub Copilot is not logged in.",
    hint: "Log in once, then check again.",
    action: "recheck_provider" as const,
    details: "exit status 1",
  };
  assert.ok(isStructured(f));
  const p = plainStructured(f);
  assert.equal(p.sentence, "GitHub Copilot is not logged in.");
  assert.equal(p.hint, f.hint);
  assert.equal(p.details, "exit status 1");
  assert.deepEqual(p.next, { kind: "check" });
  assert.doesNotMatch(p.sentence, FORBIDDEN);
});

test("each action maps to its next step; update_agent and connect_provider have none", () => {
  const m = "Something happened.";
  assert.deepEqual(plainStructured({ message: m, action: "retry" }).next, { kind: "retry" });
  assert.equal(plainStructured({ message: m, action: "update_agent", command: "npm i -g x" }).next?.kind, "command");
  assert.equal(plainStructured({ message: m, action: "connect_provider" }).next, null);
  assert.equal(plainStructured({ message: m, action: "open_settings" }).action, "open_settings");
});

test("an older harness's bare technical text is not taken for a structured message", () => {
  assert.equal(isStructured({ message: "ACP agent Copilot could not start (exit status 1)." }), false);
  assert.equal(isStructured({ message: "boom" }), false);
  assert.match(readable("ACP agent Copilot could not start (exit status 1)."), /could not start/);
  assert.doesNotMatch(readable("ACP agent Copilot exited (exit status 1)."), FORBIDDEN);
  assert.equal(readable("The model is busy."), "The model is busy.");
});
