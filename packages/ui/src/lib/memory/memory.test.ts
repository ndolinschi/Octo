import assert from "node:assert/strict";
import test from "node:test";
import type { ContextReceipt, MemoryHit, Task, TaskFact } from "@octo/agent-client";
import { draftProblem, formatBytes, sortFiles } from "./files";
import { blockLabel, idKind, receiptView } from "./receipt";
import { EMPTY_SEARCH, emptyText, hitTarget, orderHits, splitFactId, searchParams, searchProblem, toggleKind } from "./search";
import { currentFacts, factRows, filterCounts, filterTasks } from "./tasks";

const fact = (id: string, date: string, superseded_by?: string): TaskFact => ({
  id,
  text: `fact ${id}`,
  date,
  message_id: 1,
  ...(superseded_by ? { superseded_by } : {}),
});
const task = (id: string, status: Task["status"], updated_at: string, facts: TaskFact[] = []): Task => ({
  id,
  title: id,
  status,
  goal: "",
  goal_by: "orchestrator",
  auto: false,
  constraints: [],
  acceptance: [],
  quotes: [],
  decisions: [],
  outcome: "",
  files: [],
  facts,
  message_ids: [],
  created_at: updated_at,
  updated_at,
});

test("filterTasks keeps the status and orders by last update, newest first", () => {
  const tasks = [task("a", "open", "2026-01-01"), task("b", "done", "2026-03-01"), task("c", "open", "2026-02-01")];
  assert.deepEqual(
    filterTasks(tasks, "open").map((t) => t.id),
    ["c", "a"],
  );
  assert.deepEqual(
    filterTasks(tasks, "all").map((t) => t.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(filterTasks(tasks, "dropped"), []);
  assert.deepEqual(filterCounts(tasks), { all: 3, open: 2, done: 1, dropped: 0 });
});

test("factRows are chronological and resolve the replacement, in the task and across tasks", () => {
  const t = task("t1", "open", "2026-02-01", [
    fact("f2", "2026-01-05"),
    fact("f1", "2026-01-01", "f2"),
    fact("f3", "2026-01-03", "t2/g1"),
    fact("f4", "2026-01-04", "gone/x"),
  ]);
  const other = task("t2", "open", "2026-02-02", [fact("g1", "2026-01-20")]);
  const rows = factRows(t, [t, other]);
  assert.deepEqual(
    rows.map((r) => r.fact.id),
    ["f1", "f3", "f4", "f2"],
  );
  assert.equal(rows[0]?.by?.id, "f2");
  assert.equal(rows[0]?.byTask, null);
  assert.equal(rows[1]?.by?.id, "g1");
  assert.equal(rows[1]?.byTask?.id, "t2");
  assert.equal(rows[2]?.superseded, true);
  assert.equal(rows[2]?.by, null, "a replacement that cannot be found is still marked superseded");
  assert.equal(rows[3]?.superseded, false);
  assert.deepEqual(
    currentFacts(t).map((f) => f.id),
    ["f2"],
  );
});

test("orderHits puts superseded hits after current ones and keeps each group's order", () => {
  const h = (id: string, superseded?: boolean): MemoryHit => ({
    kind: "fact",
    id,
    title: id,
    snippet: "",
    date: "2026-01-01",
    ...(superseded ? { superseded } : {}),
  });
  assert.deepEqual(
    orderHits([h("a", true), h("b"), h("c", true), h("d")]).map((x) => x.id),
    ["b", "d", "a", "c"],
  );
});

test("search form: problems and request parameters", () => {
  assert.equal(searchProblem(EMPTY_SEARCH), "Type what to look for");
  assert.equal(searchProblem({ ...EMPTY_SEARCH, q: "budget", after: "2026-02-01", before: "2026-01-01" }), "The end date is not after the start date");
  assert.equal(searchProblem({ ...EMPTY_SEARCH, q: "budget", after: "01/02/2026" }), "Dates are written year-month-day");
  assert.equal(searchProblem({ ...EMPTY_SEARCH, q: "budget" }), null);
  assert.deepEqual(searchParams({ ...EMPTY_SEARCH, q: "  budget " }), { q: "budget" });
  assert.deepEqual(searchParams({ q: "x", kinds: ["files", "tasks"], after: "2026-01-01", before: "2026-02-01" }), {
    q: "x",
    in: ["tasks", "files"],
    after: "2026-01-01",
    before: "2026-02-01",
  });
  assert.deepEqual(searchParams({ q: "x", kinds: ["tasks", "facts", "files", "messages"], after: "", before: "" }), { q: "x" }, "every kind is no filter");
  assert.deepEqual(toggleKind(["tasks"], "files"), ["tasks", "files"]);
  assert.deepEqual(toggleKind(["tasks", "files"], "tasks"), ["files"]);
});

test("emptyText names the harness's message or says nothing matches", () => {
  assert.equal(emptyText(undefined), "Nothing in memory matches");
  assert.equal(emptyText("nothing in memory matches"), "Nothing in memory matches");
  assert.equal(emptyText(" "), "Nothing in memory matches");
});

const receipt: ContextReceipt = {
  turn_id: 7,
  mode: "window",
  recent_exchanges: 5,
  blocks: [
    { name: "memory_index", tokens: 300, cap: 1500, count: 2, ids: ["a.md", "b.md"] },
    { name: "recent_window", tokens: 12_000, cap: 12_000, count: 5, ids: ["1", "3"] },
    { name: "current_turn", tokens: 700, cap: 0, count: 1, ids: ["7"] },
  ],
  total_tokens: 13_000,
  caps_total: 18_000,
  message_count: 11,
  cleared_calls: 1,
  created_at: "2026-01-01T00:00:00Z",
};

test("receiptView: shares add up to the total, cap fill and capped flag, mode and cleared lines", () => {
  const v = receiptView(receipt);
  assert.equal(v.total, 13_000);
  assert.ok(Math.abs(v.segments.reduce((n, s) => n + s.share, 0) - 1) < 1e-9);
  assert.equal(v.segments[0]?.fill, 0.2);
  assert.equal(v.segments[0]?.capped, false);
  assert.equal(v.segments[1]?.capped, true);
  assert.equal(v.segments[2]?.fill, null);
  assert.equal(v.segments[2]?.capped, false);
  assert.equal(v.totalText, "13k of 18k in capped blocks");
  assert.equal(v.modeText, "Window mode, last 5 exchanges, 11 messages");
  assert.equal(v.clearedText, "1 tool result was replaced by stubs");
});

test("receiptView: a full-mode receipt has no caps, an empty one has zero shares", () => {
  const full = receiptView({
    ...receipt,
    mode: "full",
    blocks: [{ name: "history", tokens: 40_000, cap: 0, count: 3, ids: ["1"] }],
    caps_total: 0,
    cleared_calls: 0,
    message_count: 1,
  });
  assert.equal(full.totalText, "40k tokens");
  assert.equal(full.modeText, "Full history, 1 message");
  assert.equal(full.clearedText, null);
  const empty = receiptView({ ...receipt, blocks: [{ name: "facts", tokens: 0, cap: 1500, count: 0, ids: [] }] });
  assert.equal(empty.segments[0]?.share, 0);
});

test("block labels and id kinds", () => {
  assert.equal(blockLabel("recent_window"), "Recent exchanges");
  assert.equal(blockLabel("some_new_block"), "some new block");
  assert.equal(idKind("memory_index", "notes/a.md"), "file");
  assert.equal(idKind("open_tasks", "tsk_1"), "task");
  assert.equal(idKind("facts", "tsk_1/f1"), "fact");
  assert.equal(idKind("recent_window", "42"), "message");
});

test("files: order, sizes, draft limit", () => {
  assert.deepEqual(
    sortFiles([
      { path: "b.md", updated_at: "2026-01-01" },
      { path: "a.md", updated_at: "2026-01-01" },
      { path: "c.md", updated_at: "2026-02-01" },
    ]).map((f) => f.path),
    ["c.md", "a.md", "b.md"],
  );
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2458), "2.4 kB");
  assert.equal(formatBytes(64 * 1024), "64 kB");
  assert.equal(draftProblem("x".repeat(100)), null);
  assert.match(draftProblem("x".repeat(70_000)) ?? "", /^Too large/);
});

test("hitTarget: where each kind of hit opens", () => {
  const base = { title: "t", snippet: "", date: "2026-01-01" };
  assert.deepEqual(hitTarget({ ...base, kind: "task", id: "tsk_1" }), { to: "task", taskId: "tsk_1", factId: null });
  assert.deepEqual(hitTarget({ ...base, kind: "fact", id: "tsk_1/f2", task_id: "tsk_1" }), { to: "task", taskId: "tsk_1", factId: "f2" });
  assert.deepEqual(hitTarget({ ...base, kind: "fact", id: "tsk_9/f1" }), { to: "task", taskId: "tsk_9", factId: "f1" });
  assert.equal(hitTarget({ ...base, kind: "fact", id: "loose" }), null);
  assert.deepEqual(hitTarget({ ...base, kind: "file", id: "notes/a.md" }), { to: "file", path: "notes/a.md" });
  assert.deepEqual(hitTarget({ ...base, kind: "message", id: "42" }), { to: "message", messageId: 42 });
  assert.equal(hitTarget({ ...base, kind: "message", id: "x" }), null);
  assert.deepEqual(splitFactId("a/b"), { taskId: "a", factId: "b" });
  assert.equal(splitFactId("a/"), null);
});
