import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_MIN_WIDTH, EDITOR_MIN_GROUP, GROUP_GAP, MIN_GROUP } from "../../lib/constants";
import { dockFits, dockNeeds, groupFloor } from "./floors";
import { CHAT, fileTab, toolTab } from "./layout";
import { fileKey } from "../../lib/files";

const file = fileTab(fileKey("f", "a.ts"));

test("a group's floor follows what it holds", () => {
  assert.equal(groupFloor([CHAT]), CHAT_MIN_WIDTH);
  assert.equal(groupFloor([toolTab("agents")]), MIN_GROUP);
  assert.equal(groupFloor([file]), EDITOR_MIN_GROUP);
  assert.equal(groupFloor([toolTab("files")]), EDITOR_MIN_GROUP);
  assert.equal(groupFloor([toolTab("agents"), file]), EDITOR_MIN_GROUP);
  assert.equal(groupFloor([file, CHAT]), CHAT_MIN_WIDTH, "the conversation's floor is the largest");
  assert.equal(groupFloor([]), MIN_GROUP);
});

test("the dock needs the sum of the floors and the gaps", () => {
  const groups = [{ tabs: [CHAT] }, { tabs: [file] }];
  assert.equal(dockNeeds(groups), CHAT_MIN_WIDTH + EDITOR_MIN_GROUP + GROUP_GAP);
  assert.equal(dockFits(groups, dockNeeds(groups)), true);
  assert.equal(dockFits(groups, dockNeeds(groups) - 1), false);
  assert.equal(dockFits(groups, 0), true, "not measured yet");
  assert.equal(dockFits([{ tabs: [CHAT] }], 100), true, "one group always fits");
});
