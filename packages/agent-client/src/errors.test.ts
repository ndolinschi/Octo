import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type FetchLike } from "./client";
import { applyEvent, emptyProjectState } from "./state";

function bridgeWith(status: number, body: string) {
  const fetch: FetchLike = async () => ({ ok: status < 400, status, text: async () => body });
  return createHttpBridge({ baseUrl: "http://h:1/", fetch });
}

test("BridgeError carries hint, command, action and details of a structured error", async () => {
  const body = JSON.stringify({
    error: {
      code: "model_unavailable",
      message: "GitHub Copilot is not logged in.",
      hint: "Log in to it in a terminal, then check again.",
      command: "copilot auth login",
      action: "recheck_provider",
      details: "models.fast cannot run",
      provider: "copilot",
      reason: "GitHub Copilot is not logged in.",
      can_force: true,
    },
  });
  await assert.rejects(bridgeWith(422, body).listProjects(), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.message, "GitHub Copilot is not logged in.");
    assert.equal(e.hint, "Log in to it in a terminal, then check again.");
    assert.equal(e.command, "copilot auth login");
    assert.equal(e.action, "recheck_provider");
    assert.equal(e.details, "models.fast cannot run");
    return true;
  });
});

test("an unknown action is dropped; an object in details is data (rewind_conflict)", async () => {
  const body = JSON.stringify({ error: { code: "rewind_conflict", message: "Some files changed.", action: "dance", details: { files: ["a"] } } });
  await assert.rejects(bridgeWith(409, body).listProjects(), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.action, undefined);
    assert.equal(e.details, undefined);
    assert.deepEqual(e.data, { files: ["a"] });
    return true;
  });
});

test("turn.finished and project.attention keep the structured fields", () => {
  let s = emptyProjectState();
  s = applyEvent(s, {
    type: "turn.finished",
    seq: 1,
    status: "failed",
    error: "GitHub Copilot is not logged in.",
    hint: "Log in to it in a terminal, then check again.",
    command: "copilot auth login",
    action: "recheck_provider",
    details: "exit status 1",
  });
  assert.equal(s.lastTurn?.command, "copilot auth login");
  assert.equal(s.lastTurn?.action, "recheck_provider");
  assert.equal(s.lastTurn?.details, "exit status 1");
  s = applyEvent(s, {
    type: "project.attention",
    seq: 2,
    needs_you: false,
    approvals: 0,
    inputs: 0,
    state: "failed",
    error: "GitHub Copilot is not logged in.",
    command: "copilot auth login",
    action: "recheck_provider",
  });
  assert.equal(s.attention.command, "copilot auth login");
  assert.equal(s.attention.action, "recheck_provider");
});

test("a completed turn's notice is kept", () => {
  const notice = {
    message: "Claude Code could not use Octo's tools this time; the request ran without delegation and notes.",
    action: "update_agent" as const,
  };
  const s = applyEvent(emptyProjectState(), { type: "turn.finished", seq: 1, status: "completed", error: `warning: ${notice.message}`, notice });
  assert.deepEqual(s.lastTurn?.notice, notice);
});
