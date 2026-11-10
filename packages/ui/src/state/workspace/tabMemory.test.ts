import assert from "node:assert/strict";
import test from "node:test";
import { CHAT, agentTab, toolTab } from "./layout";
import { TabMemory, isBooleanRecord, isNumber, isString, slot } from "./tabMemory";

const SCROLL = slot("scroll", isNumber);
const DRAFT = slot("draft", isString);
const EXPANDED = slot("expanded", isBooleanRecord);

test("a value is read back under the same tab and slot", () => {
  const m = new TabMemory();
  assert.equal(m.get(CHAT, SCROLL), undefined);
  m.set(CHAT, SCROLL, 120);
  assert.equal(m.get(CHAT, SCROLL), 120);
  m.set(CHAT, SCROLL, 0);
  assert.equal(m.get(CHAT, SCROLL), 0, "zero is a value");
});

test("tabs and slots are independent", () => {
  const m = new TabMemory();
  m.set(CHAT, DRAFT, "hello");
  m.set(agentTab("a"), DRAFT, "other");
  m.set(CHAT, SCROLL, 5);
  assert.equal(m.get(CHAT, DRAFT), "hello");
  assert.equal(m.get(agentTab("a"), DRAFT), "other");
  assert.equal(m.get(agentTab("b"), DRAFT), undefined);
  assert.equal(m.get(CHAT, SCROLL), 5);
});

test("a value of the wrong shape is absent (a slot name reused with another type)", () => {
  const m = new TabMemory();
  m.set(CHAT, DRAFT, "text");
  assert.equal(m.get(CHAT, slot("draft", isNumber)), undefined);
  m.set(toolTab("agents"), EXPANDED, { a: true });
  assert.deepEqual(m.get(toolTab("agents"), EXPANDED), { a: true });
  assert.equal(m.get(toolTab("agents"), slot("expanded", isString)), undefined);
});

test("keys keep the v6 spelling `{tab}:{slot}` (draft, scroll, expanded)", () => {
  assert.equal(isBooleanRecord({ a: true, b: false }), true);
  assert.equal(isBooleanRecord({ a: 1 }), false);
  assert.equal(isBooleanRecord(null), false);
  assert.equal(isBooleanRecord([]), true, "an empty array has no non-boolean values; harmless for expansion overrides");
});
