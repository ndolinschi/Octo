import assert from "node:assert/strict";
import test from "node:test";
import { TabMemory } from "../../state/workspace/tabMemory";
import { CHAT } from "../../state/workspace/layout";
import { applyCrossProjectDraft, clearDraft, draftOf, prefillComposer, stashCrossProjectDraft, takeCrossProjectDraft } from "./composerDraft";

test("clearDraft clears the draft and notifies active members without leaking a listener", () => {
  const memory = new TabMemory();
  const bus = draftOf(memory, CHAT);
  const heard: string[] = [];
  const member = bus.join((t) => heard.push(t));
  member.save("hello world");
  clearDraft(bus);
  assert.equal(bus.value, "");
  assert.deepEqual(heard, [""]);
  member.leave();
});

test("stashCrossProjectDraft and takeCrossProjectDraft transfer text once to a matching project and session", () => {
  stashCrossProjectDraft("p-other", "s-2", "build the widget");

  // Mismatched project or session leaves the stashed draft intact.
  assert.equal(takeCrossProjectDraft("p-wrong", "s-2"), null);
  assert.equal(takeCrossProjectDraft("p-other", "s-1"), null);

  // Matching project and session consumes it once.
  assert.equal(takeCrossProjectDraft("p-other", "s-2"), "build the widget");
  assert.equal(takeCrossProjectDraft("p-other", "s-2"), null);
});

test("stashCrossProjectDraft with empty string clears any prior pending handoff", () => {
  stashCrossProjectDraft("p-other", "s-1", "stale text");
  stashCrossProjectDraft("p-other", "s-1", "");
  assert.equal(takeCrossProjectDraft("p-other", "s-1"), null);
});

test("takeCrossProjectDraft matches when target sessionId is null and prefillComposer writes it cleanly", () => {
  const memory = new TabMemory();
  stashCrossProjectDraft("p-2", "s-9", "draft across projects");
  const text = takeCrossProjectDraft("p-2", null);
  assert.equal(text, "draft across projects");
  if (text !== null) prefillComposer(memory, CHAT, text);
  assert.equal(draftOf(memory, CHAT).value, "draft across projects");
});

test("applyCrossProjectDraft writes into empty bus and leaves non-empty target drafts untouched", () => {
  const memory = new TabMemory();
  const bus = draftOf(memory, CHAT);
  stashCrossProjectDraft("p-3", "s-1", "incoming text");
  applyCrossProjectDraft(bus, "p-3", "s-1");
  assert.equal(bus.value, "incoming text");

  stashCrossProjectDraft("p-3", "s-1", "should not overwrite");
  applyCrossProjectDraft(bus, "p-3", "s-1");
  assert.equal(bus.value, "incoming text");
  assert.equal(takeCrossProjectDraft("p-3", "s-1"), "should not overwrite");
});
