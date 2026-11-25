import assert from "node:assert/strict";
import test from "node:test";
import { addToChat, canAddToChat, canSubmitToChat, registerChatInsert, registerChatSubmit, submitToChat } from "./chatInsert";

test("addToChat goes to the last composer mounted, and to none once all have left", () => {
  const got: string[] = [];
  assert.equal(canAddToChat(), false);
  assert.equal(addToChat("@a.ts"), false);
  const leaveChat = registerChatInsert((t) => got.push(`chat:${t}`));
  const leaveFloat = registerChatInsert((t) => got.push(`float:${t}`));
  assert.equal(canAddToChat(), true);
  addToChat("@a.ts:3");
  leaveFloat();
  addToChat("@b.ts");
  leaveChat();
  assert.equal(addToChat("@c.ts"), false);
  assert.deepEqual(got, ["float:@a.ts:3", "chat:@b.ts"]);
});

test("submitToChat dispatches to the active conversation and unregisters cleanly", () => {
  const sent: string[] = [];
  assert.equal(canSubmitToChat(), false);
  assert.equal(submitToChat("Edit @a.ts:1 — fix"), false);
  const leave = registerChatSubmit((t) => sent.push(t));
  assert.equal(canSubmitToChat(), true);
  assert.equal(submitToChat("Edit @a.ts:1-4 — extract helper"), true);
  leave();
  assert.equal(canSubmitToChat(), false);
  assert.deepEqual(sent, ["Edit @a.ts:1-4 — extract helper"]);
});
