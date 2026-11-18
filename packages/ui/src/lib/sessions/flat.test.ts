import type { GlobalSession } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { flatSessions, treeSessions } from "./flat";

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

test("flatSessions keeps a fallback session for an empty project and the active empty session", () => {
  const emptyDefault = g("s1", "test", 2, { default: true, current: true, project_name: "Test Project" });
  const emptyOther = g("s2", "test", 1, { project_name: "Test Project" });
  const emptySecondaryProject = g("s3", "other", 10, { default: true, project_name: "Other" });

  // Active empty project's open session is visible (not hidden just because exchanges === 0).
  assert.deepEqual(
    flatSessions([emptyDefault], "s1").map((s) => s.id),
    ["s1"],
  );

  // When on Home (no active session) or another project, each empty project still surfaces its default session.
  assert.deepEqual(
    flatSessions([emptyOther, emptyDefault, emptySecondaryProject], null).map((s) => s.id),
    ["s1", "s3"],
  );
});

test("flatSessions hides unused stale empty drafts on projects that already have activity, unless active", () => {
  const activeAlpha = g("a-chat", "alpha", 15, { exchanges: 3, title: "Fix login" });
  const staleEmptyAlpha = g("a-draft", "alpha", 5, { exchanges: 0 });
  const newEmptyAlpha = g("a-new", "alpha", 1, { exchanges: 0 });
  const archived = g("a-arch", "alpha", 0, { exchanges: 2, archived: true });
  const betaEmpty = g("b-def", "beta", 20, { exchanges: 0, default: true });

  assert.deepEqual(
    flatSessions([activeAlpha, staleEmptyAlpha, newEmptyAlpha, archived, betaEmpty], "a-new").map((s) => s.id),
    ["a-new", "a-chat", "b-def"],
  );
});

test("treeSessions keeps brand-new empty projects compact but reveals an active new empty session alongside existing sessions", () => {
  const onlyEmpty = [g("t1", "test", 1, { default: true })];
  assert.deepEqual(treeSessions(onlyEmpty, false, "t1"), { shown: [], hidden: 0 });

  const mixed = [g("a1", "alpha", 10, { exchanges: 2 }), g("a2", "alpha", 1, { exchanges: 0 })];
  assert.deepEqual(
    treeSessions(mixed, false, "a2").shown.map((s) => s.id),
    ["a2", "a1"],
  );
});
