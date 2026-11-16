import type { ProjectSession } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { sessionTabMode } from "./current";
import { sessionChoiceMeta, sessionChoices } from "./picker";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const s = (id: string, over: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  kind: "main",
  title: id,
  state: "idle",
  model: "",
  started_at: "2026-11-16T09:00:00Z",
  last_activity_at: "2026-11-16T09:30:00Z",
  exchanges: 1,
  children: 0,
  current: false,
  archived: false,
  can_message: true,
  ...over,
});

test("sessionChoices filters to live main sessions ordered by most recent activity and supports optional limit", () => {
  const list = [
    s("old", { last_activity_at: "2026-11-16T08:00:00Z" }),
    s("arch", { archived: true, last_activity_at: "2026-11-16T11:59:00Z" }),
    s("agent", { kind: "agent", last_activity_at: "2026-11-16T11:58:00Z" }),
    s("newest", { last_activity_at: "2026-11-16T11:30:00Z" }),
    s("mid", { last_activity_at: "2026-11-16T10:30:00Z" }),
  ];
  assert.deepEqual(
    sessionChoices(list).map((x) => x.id),
    ["newest", "mid", "old"],
  );
  assert.deepEqual(
    sessionChoices(list, 2).map((x) => x.id),
    ["newest", "mid"],
  );
});

test("sessionChoiceMeta marks open tabs, default session, and active-in-chat hints cleanly", () => {
  const def = s("s1", { default: true, current: true, last_activity_at: "2026-11-16T11:00:00Z" });
  assert.deepEqual(sessionChoiceMeta(def, { activeId: "s1", openTab: false, now: NOW, markActiveHint: true }), {
    detail: "default",
    hint: "in Chat",
  });
  assert.deepEqual(sessionChoiceMeta(def, { activeId: "s1", openTab: true, now: NOW, markActiveHint: true }), {
    detail: "open",
    hint: "in Chat",
  });
  const working = s("s2", { state: "working" });
  assert.deepEqual(sessionChoiceMeta(working, { activeId: "s1", openTab: false, now: NOW }), {});
});

test("sessionTabMode waits for initial sync when unknown, opens upserted parallel sessions immediately, and shows agent detail", () => {
  assert.equal(sessionTabMode({ parallel: false, kind: undefined, synced: 0 }), "loading");
  assert.equal(sessionTabMode({ parallel: true, kind: undefined, synced: 0 }), "loading");
  // Newly created session upserted before syncAll finishes opens immediately as a conversation.
  assert.equal(sessionTabMode({ parallel: true, kind: "main", synced: 0 }), "conversation");
  assert.equal(sessionTabMode({ parallel: true, kind: undefined, synced: 1 }), "conversation");
  assert.equal(sessionTabMode({ parallel: true, kind: "agent", synced: 1 }), "detail");
  assert.equal(sessionTabMode({ parallel: false, kind: undefined, synced: 1 }), "detail");
});
