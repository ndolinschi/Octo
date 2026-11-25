import assert from "node:assert/strict";
import test from "node:test";
import { deviceChanged, deviceOf, WEB_PHONE_QUERY } from "./device";

test("the device capability comes from /pair/me", () => {
  assert.deepEqual(deviceOf({ read_only: true, permissions: ["send", "answer", "stop"] }), { readOnly: true, permissions: ["send", "answer", "stop"] });
  assert.deepEqual(deviceOf({ read_only: false, permissions: [] }), { readOnly: false, permissions: [] });
});

test("a change of read-only or permissions is noticed, nothing else", () => {
  const a = { read_only: false, permissions: ["send", "answer", "stop"] };
  assert.equal(deviceChanged(a, { ...a }), false);
  assert.equal(deviceChanged(a, { ...a, read_only: true }), true);
  assert.equal(deviceChanged(a, { ...a, permissions: ["answer"] }), true);
});

test("WEB_PHONE_QUERY matches packages/ui landscape height threshold", () => {
  assert.equal(WEB_PHONE_QUERY, "(max-width: 640px), (pointer: coarse) and (max-height: 479.98px)");
});
