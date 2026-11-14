import assert from "node:assert/strict";
import test from "node:test";
import { agentWaiting, WAIT_TEXT } from "./agentWaiting";

test("NEW-3: an agent waits on its own approval first, then its own form; another agent's do not count", () => {
  const state = { approvals: [{ agent_id: "a1" }], inputs: [{ agent_id: "a1" }, { agent_id: "a2" }] };
  assert.equal(agentWaiting(state, "a1"), "approval");
  assert.equal(agentWaiting(state, "a2"), "input");
  assert.equal(agentWaiting(state, "a3"), null);
  assert.equal(WAIT_TEXT.approval, "Waiting for your approval");
  assert.equal(WAIT_TEXT.input, "Waiting for your answer");
});
