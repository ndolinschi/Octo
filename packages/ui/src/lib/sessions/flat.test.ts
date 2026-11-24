import type { GlobalSession } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { flatSessions, pinNeedsYou, treeSessions } from "./flat";

test("pinNeedsYou puts waiting and failed sessions first, each group in the list's order", () => {
  const list = [
    g("a", "p", 1, { exchanges: 1, state: "working" }),
    g("b", "p", 2, { exchanges: 1, state: "waiting" }),
    g("c", "p", 3, { exchanges: 1 }),
    g("d", "p", 4, { exchanges: 1, state: "failed" }),
    g("e", "p", 5, { exchanges: 1, needs_you: true }),
  ];
  const { needs, rest } = pinNeedsYou(list);
  assert.deepEqual(
    needs.map((s) => s.id),
    ["b", "d", "e"],
  );
  assert.deepEqual(
    rest.map((s) => s.id),
    ["a", "c"],
  );
  assert.deepEqual(pinNeedsYou([g("x", "p", 1)]).needs, []);
});

const NOW = Date.parse("2026-11-17T22:00:00Z");
const g = (id: string, projectId: string, minutesAgo: number, over: Partial<GlobalSession> = {}): GlobalSession => ({
  id,
  project_id: projectId,
  project_name: `Project ${projectId}`,
  kind: "main",
  title: "",
  state: "idle",
  model: "m",
  started_at: new Date(NOW - minutesAgo * 60_000 - 1000).toISOString(),
  last_activity_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  exchanges: 0,
  children: 0,
  current: false,
  archived: false,
  can_message: true,
  ...over,
});

test("flatSessions hides untouched empty default sessions so empty projects show as project rows instead of phantom New session entries", () => {
  const emptyDefault = g("s1", "test", 2, { default: true, current: true, project_name: "Test Project" });
  const emptyOther = g("s2", "test", 1, { project_name: "Test Project" });
  const emptySecondaryProject = g("s3", "other", 10, { default: true, project_name: "Other" });

  // Neither the active empty default session nor inactive empty project defaults appear in flatSessions.
  assert.deepEqual(flatSessions([emptyDefault], "s1"), []);
  assert.deepEqual(flatSessions([emptyOther, emptyDefault, emptySecondaryProject], null), []);

  // As soon as a message is queued or running, the session appears.
  const queued = g("s4", "test", 1, { queued: 1 });
  const working = g("s5", "other", 2, { state: "working" });
  assert.deepEqual(
    flatSessions([emptyDefault, queued, working], "s4").map((s) => s.id),
    ["s4", "s5"],
  );
});

test("flatSessions keeps only non-archived main sessions with activity", () => {
  const activeAlpha = g("a-chat", "alpha", 15, { exchanges: 3, title: "Fix login" });
  const staleEmptyAlpha = g("a-draft", "alpha", 5, { exchanges: 0 });
  const newEmptyAlpha = g("a-new", "alpha", 1, { exchanges: 0 });
  const archived = g("a-arch", "alpha", 0, { exchanges: 2, archived: true });
  const betaEmpty = g("b-def", "beta", 20, { exchanges: 0, default: true });

  assert.deepEqual(
    flatSessions([activeAlpha, staleEmptyAlpha, newEmptyAlpha, archived, betaEmpty], "a-new").map((s) => s.id),
    ["a-chat"],
  );
});

test("treeSessions hides empty idle sessions for both brand-new and active projects", () => {
  const onlyEmpty = [g("t1", "test", 1, { default: true })];
  assert.deepEqual(treeSessions(onlyEmpty, false, "t1"), { shown: [], hidden: 0 });

  const mixed = [g("a1", "alpha", 10, { exchanges: 2 }), g("a2", "alpha", 1, { exchanges: 0 })];
  assert.deepEqual(
    treeSessions(mixed, false, "a2").shown.map((s) => s.id),
    ["a1"],
  );
});

test("flatSessions orders by start, not activity, so rows do not swap as sessions work", () => {
  const older = g("old", "alpha", 60, { exchanges: 2, last_activity_at: new Date(NOW).toISOString() });
  const newer = g("new", "beta", 5, { exchanges: 2 });
  const tieA = g("t-a", "gamma", 30, { exchanges: 1 });
  const tieB = g("t-b", "gamma", 30, { exchanges: 1 });
  assert.deepEqual(
    flatSessions([older, tieB, newer, tieA], null).map((s) => s.id),
    ["new", "t-a", "t-b", "old"],
  );
});
