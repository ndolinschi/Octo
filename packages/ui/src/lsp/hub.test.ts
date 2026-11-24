import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fileKey } from "../lib/files";
import { EditorIntel, type IntelClient } from "./hub";

const A = fileKey("p", "a");
const B = fileKey("p", "b");

// The hub uses window.setTimeout; in node the global object stands in for it.
(globalThis as unknown as { window: unknown }).window = globalThis;

const client = () => {
  const calls: string[] = [];
  const c: IntelClient = { retry: (k) => void calls.push(`retry ${k}`), dispose: () => void calls.push("dispose") };
  return { c, calls };
};

test("an unknown file has stable empty intel (a safe external-store snapshot)", () => {
  const hub = new EditorIntel();
  assert.equal(hub.get(A), hub.get(B));
  assert.deepEqual(hub.get(A), { status: null, problems: [], notice: null });
});

test("changes notify subscribers; an identical status does not; unsubscribing stops it", () => {
  const hub = new EditorIntel();
  let n = 0;
  const off = hub.subscribe(() => void (n += 1));
  const status = { label: "gopls", state: "ready" as const, error: null };
  hub.setStatus(A, status);
  hub.setStatus(A, status);
  assert.equal(n, 1);
  assert.equal(hub.get(A).status, status);
  hub.setProblems(A, [{ severity: "error", message: "x", source: null, line: 1, column: 1 }]);
  assert.equal(n, 2);
  assert.equal(hub.get(A).status, status, "setting problems keeps the status");
  off();
  hub.setStatus(A, null);
  assert.equal(n, 2);
});

test("files are independent, and clearing a file forgets it (and notifies only if it existed)", () => {
  const hub = new EditorIntel();
  let n = 0;
  hub.subscribe(() => void (n += 1));
  hub.setStatus(A, { label: "l", state: "starting", error: null });
  hub.clear(B);
  assert.equal(n, 1);
  hub.clear(A);
  assert.equal(n, 2);
  assert.equal(hub.get(A).status, null);
});

test("a notice shows, then disappears after four seconds; a newer one restarts the clock", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const hub = new EditorIntel();
    hub.notify(A, "Definition is outside the project");
    assert.equal(hub.get(A).notice, "Definition is outside the project");
    mock.timers.tick(3000);
    hub.notify(A, "second");
    mock.timers.tick(3000);
    assert.equal(hub.get(A).notice, "second", "the first timer was cancelled");
    mock.timers.tick(1000);
    assert.equal(hub.get(A).notice, null);
  } finally {
    mock.timers.reset();
  }
});

test("the client starts once, retries are forwarded, and dispose resets everything for a fresh start", () => {
  const hub = new EditorIntel();
  const first = client();
  const second = client();
  hub.retry(A);
  hub.start(() => first.c);
  hub.start(() => second.c);
  hub.retry(A);
  assert.deepEqual(first.calls, [`retry ${A}`]);
  assert.deepEqual(second.calls, [], "the second factory is never used");
  hub.setStatus(A, { label: "l", state: "ready", error: null });
  let n = 0;
  hub.subscribe(() => void (n += 1));
  hub.dispose();
  assert.deepEqual(first.calls, [`retry ${A}`, "dispose"]);
  assert.equal(n, 1);
  assert.equal(hub.get(A).status, null);
  hub.start(() => second.c);
  hub.retry(B);
  assert.deepEqual(second.calls, [`retry ${B}`]);
});

test("allProblems aggregates diagnostics across files with a stable cached reference", () => {
  const hub = new EditorIntel();
  const empty1 = hub.allProblems();
  const empty2 = hub.allProblems();
  assert.equal(empty1, empty2);
  assert.deepEqual(empty1, []);

  hub.setProblems(A, [{ severity: "error", message: "bad type", source: "ts", line: 4, column: 2 }]);
  hub.setProblems(B, [{ severity: "warning", message: "unused", source: "ts", line: 9, column: 1 }]);
  const snap1 = hub.allProblems();
  const snap2 = hub.allProblems();
  assert.equal(snap1, snap2);
  assert.equal(snap1.length, 2);
  assert.equal(snap1[0]?.key, A);
  assert.equal(snap1[1]?.key, B);

  hub.clear(A);
  const snap3 = hub.allProblems();
  assert.notEqual(snap3, snap1);
  assert.equal(snap3.length, 1);
  assert.equal(snap3[0]?.key, B);
});
