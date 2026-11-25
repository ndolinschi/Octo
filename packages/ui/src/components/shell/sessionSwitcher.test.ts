import type { ProjectSession } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { MENU_SESSIONS_SHOWN, sessionMenuItems } from "./sessionSwitcher";

const s = (id: string, over: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  kind: "main",
  title: `Session ${id}`,
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

test("sessionMenuItems builds creation actions, checked radio rows for recent sessions, and All sessions count when capped", () => {
  const sessions = Array.from({ length: MENU_SESSIONS_SHOWN + 2 }, (_, i) => s(`${i + 1}`, { default: i === 0, current: i === 0 }));
  const selected: string[] = [];
  const created: string[] = [];
  let showedAll = false;
  const items = sessionMenuItems({
    sessions,
    activeId: "2",
    onSelect: (id) => selected.push(id),
    onCreate: (target) => created.push(target),
    onShowAll: () => {
      showedAll = true;
    },
  });
  const ids = items.map((i) => i.id);
  assert.deepEqual(ids, ["new-session", "new-session-tab", "cap-sessions", "session:1", "session:2", "session:3", "session:4", "session:5", "sessions"]);
  const row2 = items.find((i) => i.id === "session:2");
  assert.ok(row2 && "run" in row2);
  assert.equal(row2.checked, true);
  row2.run();
  assert.deepEqual(selected, ["2"]);

  const newRow = items.find((i) => i.id === "new-session");
  assert.ok(newRow && "run" in newRow);
  newRow.run();
  assert.deepEqual(created, ["show"]);

  const allRow = items.find((i) => i.id === "sessions");
  assert.ok(allRow && "run" in allRow);
  assert.equal(allRow.label, `All sessions (${MENU_SESSIONS_SHOWN + 2})…`);
  allRow.run();
  assert.equal(showedAll, true);
});

test("sessionMenuItems omits Show sessions row when onShowAll is omitted", () => {
  const items = sessionMenuItems({
    sessions: [s("1", { default: true, current: true }), s("2")],
    activeId: "1",
    onSelect: () => undefined,
    onCreate: () => undefined,
  });
  assert.deepEqual(
    items.map((i) => i.id),
    ["new-session", "new-session-tab", "cap-sessions", "session:1", "session:2"],
  );
});
