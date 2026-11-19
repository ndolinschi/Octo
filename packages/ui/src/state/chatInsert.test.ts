import assert from "node:assert/strict";
import test from "node:test";
import { addToChat, canAddToChat, registerChatInsert } from "./chatInsert";

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
