import type { ProjectSession, ProjectSummary } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { findReusableSharedSession, isUnusedEmptyMain, sortProjectsByRecent } from "./projectBarState";

function session(patch: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id: "s1",
    kind: "main",
    title: "New session",
    state: "idle",
    model: "mock/model",
    started_at: "2026-11-01T00:00:00Z",
    last_activity_at: "2026-11-01T00:00:00Z",
    exchanges: 0,
    children: 0,
    current: false,
    archived: false,
    queued: 0,
    can_message: true,
    ...patch,
  };
}

function project(id: string, created_at: string): ProjectSummary {
  return {
    id,
    name: id,
    description: "",
    status: "idle",
    folder_count: 1,
    agent_count: 1,
    created_at,
    updated_at: created_at,
  };
}

test("isUnusedEmptyMain requires idle, non-archived main session with zero exchanges, children and queued items", () => {
  assert.equal(isUnusedEmptyMain(session()), true);
  assert.equal(isUnusedEmptyMain(session({ archived: true })), false);
  assert.equal(isUnusedEmptyMain(session({ exchanges: 1 })), false);
  assert.equal(isUnusedEmptyMain(session({ children: 1 })), false);
  assert.equal(isUnusedEmptyMain(session({ queued: 1 })), false);
  assert.equal(isUnusedEmptyMain(session({ state: "working" })), false);
  assert.equal(isUnusedEmptyMain(session({ kind: "agent" })), false);
});

test("sortProjectsByRecent sorts newest first without mutating input and ties break by id", () => {
  const input = [
    project("b", "2026-11-01T00:00:00Z"),
    project("a", "2026-11-01T00:00:00Z"),
    project("c", "2026-11-10T00:00:00Z"),
    project("bad", "not-a-date"),
  ];
  const sorted = sortProjectsByRecent(input);
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["c", "a", "b", "bad"],
  );
  assert.deepEqual(
    input.map((p) => p.id),
    ["b", "a", "c", "bad"],
    "input array is not mutated",
  );
});

test("findReusableSharedSession prefers default empty shared session and skips worktrees", () => {
  const wt = session({ id: "wt", workspace: { id: "w1", kind: "worktree", title: "Worktree", branch: "octo/1" } });
  const nonDefault = session({ id: "s2", default: false });
  const def = session({ id: "s-def", default: true });
  assert.equal(findReusableSharedSession([wt, nonDefault, def])?.id, "s-def");
  assert.equal(findReusableSharedSession([wt, nonDefault])?.id, "s2");
  assert.equal(findReusableSharedSession([wt]), undefined);
});
