import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TAB_FLAGS, isTabEnabled, resolveTabFlags, type TabFeatureKey } from "./tabFlags";

test("DEFAULT_TAB_FLAGS: disables sessions, agents, notes, details, usage, memory; enables other tabs", () => {
  assert.deepEqual(DEFAULT_TAB_FLAGS, {
    sessions: false,
    agents: false,
    notes: false,
    details: false,
    usage: false,
    memory: false,
    files: true,
    browser: true,
    terminal: true,
    processes: true,
    changes: true,
    review: true,
    side: true,
  });
});

test("resolveTabFlags: applies host overrides and URL ?tabs= query tokens in order", () => {
  assert.deepEqual(resolveTabFlags(), DEFAULT_TAB_FLAGS);
  assert.equal(resolveTabFlags({ sessions: true, files: false }).sessions, true);
  assert.equal(resolveTabFlags({ sessions: true, files: false }).files, false);

  const all = resolveTabFlags(undefined, "?demo=1&tabs=all");
  for (const k of Object.keys(DEFAULT_TAB_FLAGS) as TabFeatureKey[]) assert.equal(all[k], true, k);

  const none = resolveTabFlags(undefined, "?tabs=none");
  for (const k of Object.keys(DEFAULT_TAB_FLAGS) as TabFeatureKey[]) assert.equal(none[k], false, k);

  const selective = resolveTabFlags(undefined, "?tabs=sessions, memory , -files, -terminal, unknown");
  assert.equal(selective.sessions, true);
  assert.equal(selective.memory, true);
  assert.equal(selective.agents, false);
  assert.equal(selective.files, false);
  assert.equal(selective.terminal, false);
  assert.equal(selective.changes, true);

  const allMinus = resolveTabFlags(undefined, "?tabs=all,-usage,-notes");
  assert.equal(allMinus.sessions, true);
  assert.equal(allMinus.usage, false);
  assert.equal(allMinus.notes, false);
});

test("isTabEnabled: combines feature flags with per-project memoryBlocked", () => {
  assert.equal(isTabEnabled(DEFAULT_TAB_FLAGS, "files"), true);
  assert.equal(isTabEnabled(DEFAULT_TAB_FLAGS, "sessions"), false);
  assert.equal(isTabEnabled(DEFAULT_TAB_FLAGS, "memory"), false);

  const withMem = resolveTabFlags({ memory: true });
  assert.equal(isTabEnabled(withMem, "memory"), true);
  assert.equal(isTabEnabled(withMem, "memory", { memoryBlocked: false }), true);
  assert.equal(isTabEnabled(withMem, "memory", { memoryBlocked: true }), false);
});
