import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_MIN_WIDTH, EDITOR_MIN_GROUP, GROUP_GAP, MIN_GROUP } from "../../lib/constants";
import { dockFits, dockNeeds, groupFloor, groupFloors } from "./floors";
import { CHAT, fileTab, sessionTab, toolTab } from "./layout";
import { fileKey } from "../../lib/files";

const file = fileTab(fileKey("f", "a.ts"));

test("a group's floor follows what it holds", () => {
  assert.equal(groupFloor([CHAT]), CHAT_MIN_WIDTH);
  assert.equal(groupFloor([sessionTab("s1")]), CHAT_MIN_WIDTH, "a session conversation tab uses the conversation floor");
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

test("a file group with a tree column needs the column plus the editor floor", () => {
  assert.equal(groupFloor([file], 220), 220 + EDITOR_MIN_GROUP);
  assert.equal(groupFloor([toolTab("agents")], 220), MIN_GROUP, "lists have no tree");
  assert.equal(groupFloor([CHAT], 220), CHAT_MIN_WIDTH);
});

test("the tree floors hold while the dock can give them, else the plain floors", () => {
  const groups = [
    { id: "a", tabs: [CHAT] },
    { id: "b", tabs: [file] },
  ];
  const col = (id: string) => (id === "b" ? 220 : 0);
  const needs = CHAT_MIN_WIDTH + 220 + EDITOR_MIN_GROUP + GROUP_GAP;
  assert.deepEqual(groupFloors(groups, needs, col), [CHAT_MIN_WIDTH, 220 + EDITOR_MIN_GROUP]);
  assert.deepEqual(groupFloors(groups, needs - 1, col), [CHAT_MIN_WIDTH, EDITOR_MIN_GROUP]);
  assert.deepEqual(groupFloors(groups, 0, col), [CHAT_MIN_WIDTH, EDITOR_MIN_GROUP], "not measured");
  assert.deepEqual(
    groupFloors(groups, 5000, () => 0),
    [CHAT_MIN_WIDTH, EDITOR_MIN_GROUP],
    "tree hidden",
  );
});
