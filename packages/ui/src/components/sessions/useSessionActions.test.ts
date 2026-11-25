import { BridgeError } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { failureText } from "./useSessionActions";

test("a refusal the harness described itself is shown as its own message and hint", () => {
  const e = new BridgeError(409, "session_running", "This session is still working.", { hint: "Stop it first, then resume it." });
  assert.equal(failureText(e), "This session is still working. Stop it first, then resume it.");
});

test("an older harness's bare refusal falls back to the fixed text for its code", () => {
  const e = new BridgeError(409, "current_session", "conflict");
  assert.equal(failureText(e), "This is the project's default session. Make another one the default first.");
});

test("anything that is not a bridge error says try again", () => {
  assert.equal(failureText(new Error("network down")), "network down Try again.");
});
