import assert from "node:assert/strict";
import test from "node:test";
import { detectNotificationEvents, type SessionSnapshot } from "./notifications";

const snap = (id: string, over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id,
  project_id: "p1",
  project_name: "Atlas API",
  title: "Fix retry loop",
  state: "idle",
  ...over,
});

test("detectNotificationEvents emits finished, failed, and needs transitions only on state change", () => {
  const prev = new Map<string, SessionSnapshot>([
    ["s1", snap("s1", { state: "working" })],
    ["s2", snap("s2", { state: "working" })],
    ["s3", snap("s3", { state: "working" })],
    ["s4", snap("s4", { state: "idle" })],
    ["s5", snap("s5", { state: "failed" })],
  ]);

  const events = detectNotificationEvents(prev, [
    snap("s1", { state: "idle" }),
    snap("s2", { state: "waiting" }),
    snap("s3", { state: "failed" }),
    snap("s4", { state: "idle" }),
    snap("s5", { state: "failed" }),
    snap("s6", { state: "working" }), // newly seen, no previous snapshot
  ]);

  assert.deepEqual(
    events.map((e) => [e.sessionId, e.kind, e.title]),
    [
      ["s1", "finished", "Atlas API finished"],
      ["s2", "needs", "Atlas API needs your input"],
      ["s3", "failed", "Atlas API failed"],
    ],
  );
});
