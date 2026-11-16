import type { ProjectSession } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { hasSessionMessages, isOpen, mainSessions, parseOpen, projectSummary, sessionGlyph, sessionMeta, treeKey, visibleSessions, type KeyRow } from "./tree";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const s = (id: string, minutesAgo: number, over: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  kind: "main",
  title: id,
  state: "idle",
  model: "m",
  started_at: new Date(NOW - minutesAgo * 60_000 - 1000).toISOString(),
  last_activity_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  exchanges: 1,
  children: 0,
  current: false,
  archived: false,
  can_message: true,
  ...over,
});

test("an open project shows its five newest sessions plus the live ones beyond them, then Show all (N)", () => {
  const list = [
    ...Array.from({ length: 8 }, (_, i) => s(`s${i}`, (i + 1) * 10)),
    s("old-working", 500, { state: "working" }),
    s("old-waiting", 600, { state: "waiting" }),
    s("old-queued", 700, { state: "queued" }),
    s("archived", 1, { archived: true }),
    { ...s("agent", 1), kind: "agent" as const },
  ];
  const folded = visibleSessions(list, false);
  assert.deepEqual(
    folded.shown.map((x) => x.id),
    ["s0", "s1", "s2", "s3", "s4", "old-working", "old-waiting", "old-queued"],
  );
  assert.equal(folded.hidden, 3);
  const all = visibleSessions(list, true);
  assert.equal(all.shown.length, 11);
  assert.equal(all.hidden, 0);
  // Show all stops at fifty.
  const many = Array.from({ length: 60 }, (_, i) => s(`m${i}`, i + 1));
  assert.deepEqual([visibleSessions(many, true).shown.length, visibleSessions(many, true).hidden], [50, 10]);
});

test("newest activity first; archived, agent, and empty idle sessions are not rows", () => {
  const list = [
    s("a", 30),
    s("b", 5),
    s("c", 60, { archived: true }),
    s("empty-idle", 1, { exchanges: 0, state: "idle" }),
    s("empty-working", 2, { exchanges: 0, state: "working" }),
    s("empty-queued", 3, { exchanges: 0, state: "idle", queued: 1 }),
  ];
  assert.deepEqual(
    mainSessions(list).map((x) => x.id),
    ["empty-working", "empty-queued", "b", "a"],
  );
  assert.equal(hasSessionMessages(s("x", 1, { exchanges: 0, state: "idle" })), false);
  assert.equal(hasSessionMessages(s("x", 1, { exchanges: 0, state: "waiting" })), true);
  assert.equal(hasSessionMessages(s("x", 1, { exchanges: 1, state: "idle" })), true);
});

test("the project's glyph sums up its sessions: needs you > failed > working > queued > idle", () => {
  assert.deepEqual(projectSummary([]), { glyph: null, running: 0 });
  assert.deepEqual(projectSummary([s("empty", 1, { exchanges: 0, state: "idle" })]), { glyph: null, running: 0 });
  assert.equal(projectSummary([s("a", 1), s("b", 2, { state: "queued" })]).glyph, "queued");
  assert.equal(projectSummary([s("a", 1, { state: "queued" }), s("b", 2, { state: "working" })]).glyph, "working");
  assert.equal(projectSummary([s("a", 1, { state: "working" }), s("b", 2, { state: "failed" })]).glyph, "failed");
  assert.equal(projectSummary([s("a", 1, { state: "failed" }), s("b", 2, { state: "waiting" })]).glyph, "needs");
  assert.equal(projectSummary([s("a", 1, { state: "working" }), s("b", 2, { state: "working" }), s("c", 3, { state: "waiting" })]).running, 2);
  assert.equal(projectSummary([s("a", 1, { state: "failed", archived: true })]).glyph, null);
});

test("a session's glyph and meta", () => {
  assert.equal(sessionGlyph(s("a", 1, { state: "stopped" })), "stopped");
  assert.equal(sessionGlyph(s("a", 1, { needs_you: true })), "needs");
  assert.equal(sessionMeta(s("a", 1, { state: "working" }), NOW), null);
  assert.equal(sessionMeta(s("a", 1, { state: "queued" }), NOW), "queued");
  assert.equal(sessionMeta(s("a", 90), NOW), "1h");
});

test("open state: the person's choice wins; else open when active or live", () => {
  assert.equal(isOpen({}, "p", true, false), true);
  assert.equal(isOpen({}, "p", false, true), true);
  assert.equal(isOpen({}, "p", false, false), false);
  assert.equal(isOpen({ p: false }, "p", true, true), false);
  assert.equal(isOpen({ p: true }, "p", false, false), true);
  assert.deepEqual(parseOpen({ a: true, b: "x", c: false }), { a: true, c: false });
  assert.deepEqual(parseOpen([1]), {});
  assert.deepEqual(parseOpen(null), {});
});

test("the tree's keys: up/down, right opens then enters, left closes then goes to the project, letters jump", () => {
  const rows: KeyRow[] = [
    { id: "p1", level: 1, open: true, title: "Atlas" },
    { id: "s1", level: 2, title: "Fix login" },
    { id: "s2", level: 2, title: "Plan release" },
    { id: "p2", level: 1, open: false, title: "Orbit" },
  ];
  assert.deepEqual(treeKey("ArrowDown", rows, 0), { focus: 1 });
  assert.equal(treeKey("ArrowDown", rows, 3), null);
  assert.deepEqual(treeKey("ArrowUp", rows, 1), { focus: 0 });
  assert.deepEqual(treeKey("ArrowRight", rows, 3), { toggle: "p2", open: true });
  assert.deepEqual(treeKey("ArrowRight", rows, 0), { focus: 1 });
  assert.equal(treeKey("ArrowRight", rows, 1), null);
  assert.deepEqual(treeKey("ArrowLeft", rows, 2), { focus: 0 });
  assert.deepEqual(treeKey("ArrowLeft", rows, 0), { toggle: "p1", open: false });
  assert.equal(treeKey("ArrowLeft", rows, 3), null);
  assert.deepEqual(treeKey("Home", rows, 2), { focus: 0 });
  assert.deepEqual(treeKey("End", rows, 0), { focus: 3 });
  assert.deepEqual(treeKey("o", rows, 0), { focus: 3 });
  assert.deepEqual(treeKey("p", rows, 2), { focus: 2 }, "wraps around to the row itself when it is the only match");
  assert.equal(treeKey("Enter", rows, 0), null);
});
