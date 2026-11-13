import assert from "node:assert/strict";
import test from "node:test";
import { planError } from "./modeLabels";
import { effectiveMode, modeNote, modeToSend, nextMode } from "./modes";

test("Shift+Tab cycles agent, ask, plan and back", () => {
  assert.equal(nextMode("agent"), "ask");
  assert.equal(nextMode("ask"), "plan");
  assert.equal(nextMode("plan"), "agent");
});

test("effective mode: the message's choice, else the project's default, else agent", () => {
  assert.equal(effectiveMode("plan", "ask"), "plan");
  assert.equal(effectiveMode(null, "ask"), "ask");
  assert.equal(effectiveMode(null, undefined), "agent");
});

test("only a differing mode is sent as an override", () => {
  assert.equal(modeToSend(null, "ask"), null);
  assert.equal(modeToSend("ask", "ask"), null);
  assert.equal(modeToSend("plan", "ask"), "plan");
  assert.equal(modeToSend("agent", undefined), null);
  assert.equal(modeToSend("agent", "plan"), "agent");
});

test("read-only modes say so in one line; agent says nothing", () => {
  assert.equal(modeNote("agent"), null);
  assert.match(modeNote("ask") ?? "", /read-only/);
  assert.match(modeNote("plan") ?? "", /read-only/);
});

test("plan errors", () => {
  assert.equal(planError("plan_not_pending")?.refresh, true);
  assert.equal(planError("turn_in_progress")?.refresh, false);
  assert.equal(planError("other"), null);
});
