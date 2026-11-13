import assert from "node:assert/strict";
import test from "node:test";
import type { Task, TaskFact } from "@octo/agent-client";
import {
  filterCounts,
  filterTasks,
  fold,
  itemDescription,
  keeperName,
  kindLabel,
  needsFullFact,
  rememberedGroups,
  rememberedItems,
  sourceText,
  taskDescription,
} from "./tasks";

const fact = (id: string, date: string, over: Partial<TaskFact> = {}): TaskFact => ({ id, text: `fact ${id}`, date, message_id: 1, ...over });
const task = (id: string, status: Task["status"], updated_at: string, facts: TaskFact[] = [], goal = ""): Task => ({
  id,
  title: `Task ${id}`,
  status,
  goal,
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

test("tasks: filter by status, newest update first, counts", () => {
  const tasks = [task("a", "open", "2026-01-01"), task("b", "done", "2026-03-01"), task("c", "open", "2026-02-01")];
  assert.deepEqual(
    filterTasks(tasks, "open").map((t) => t.id),
    ["c", "a"],
  );
  assert.deepEqual(filterTasks(tasks, "dropped"), []);
  assert.deepEqual(filterCounts(tasks), { open: 2, done: 1, dropped: 0 });
  assert.equal(taskDescription(task("a", "open", "x", [], "\nFirst line.\nSecond.")), "First line.");
  assert.equal(taskDescription(task("a", "open", "x")), "No goal written yet");
});

test("superseded facts fold under their successor: in the task, across tasks, along a chain; never listed alone", () => {
  const t1 = task("t1", "open", "2026-02-01", [
    fact("f1", "2026-01-01", { superseded_by: "f2" }),
    fact("f2", "2026-01-05", { superseded_by: "f3" }),
    fact("f3", "2026-01-09"),
    fact("f4", "2026-01-03", { superseded_by: "t2/g1" }),
    fact("f5", "2026-01-04", { superseded_by: "gone/x" }),
  ]);
  const t2 = task("t2", "open", "2026-02-02", [fact("g1", "2026-01-20")]);
  const items = rememberedItems([t1, t2]);
  assert.deepEqual(
    items.map((i) => i.key),
    ["t2/g1", "t1/f3"],
    "newest first",
  );
  assert.deepEqual(
    items[1]?.earlier.map((f) => f.id),
    ["f2", "f1"],
    "earlier versions, newest first",
  );
  assert.deepEqual(
    items[0]?.earlier.map((f) => f.id),
    ["f4"],
  );
  assert.ok(!items.some((i) => i.fact.id === "f5"), "a replacement that cannot be found is not listed");
  assert.equal(itemDescription(items[1]!), "2 earlier versions"); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- asserted above
});

test("a cycle of replacements does not hang", () => {
  const t = task("t", "open", "2026-01-01", [fact("a", "2026-01-01", { superseded_by: "b" }), fact("b", "2026-01-02", { superseded_by: "a" })]);
  assert.deepEqual(rememberedItems([t]), []);
});

test("kind labels, keepers and the source line", () => {
  assert.equal(kindLabel(undefined), null);
  assert.equal(kindLabel("fact"), null);
  assert.equal(kindLabel("todo"), "To do");
  assert.equal(
    keeperName(undefined, () => null),
    null,
  );
  assert.equal(
    keeperName("user", () => "x"),
    "You",
  );
  assert.equal(
    keeperName("agt_1", () => null),
    "Orchestrator",
  );
  assert.equal(
    keeperName("agt_1", () => "Explorer"),
    "Explorer",
  );
  const now = Date.parse("2026-11-12T12:00:00Z");
  assert.equal(sourceText(fact("f", "2026-11-12T08:00:00Z"), "Orchestrator", now), "Remembered by Orchestrator · Nov 12");
  assert.equal(sourceText(fact("f", "2026-11-12T08:00:00Z"), null, now), "Noted · Nov 12");
  const about = task("t", "open", "x", [fact("f", "2026-11-12T08:00:00Z", { kind: "decision", about: "Auth" })]);
  assert.equal(itemDescription(rememberedItems([about])[0]!), "Decision"); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- one fact in, one item out
});

test("folding a long list shows the first eight, but never hides a single row", () => {
  const ten = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(fold(ten, false), { shown: ten.slice(0, 8), hidden: 2 });
  assert.equal(fold(ten, true).hidden, 0);
  assert.equal(fold(ten.slice(0, 9), false).hidden, 0, "hiding one row costs more than showing it");
});

test("an open fact repeats its text only when the row may have cut it", () => {
  assert.equal(needsFullFact("Access tokens live for 15 minutes"), false);
  assert.equal(needsFullFact("x".repeat(80)), true);
  assert.equal(needsFullFact("a\nb"), true);
});

test("remembered items group by subject, the newest-touched group first, items without a subject under General", () => {
  const t = task("t", "open", "2026-02-01", [
    fact("a", "2026-01-01", { about: "Auth" }),
    fact("b", "2026-01-09"),
    fact("c", "2026-01-05", { about: "Billing" }),
    fact("d", "2026-01-07", { about: "Auth" }),
    fact("e", "2026-01-02", { about: "  " }),
  ]);
  const groups = rememberedGroups(rememberedItems([t]));
  assert.deepEqual(
    groups.map((g) => g.subject),
    ["General", "Auth", "Billing"],
  );
  assert.deepEqual(
    groups.map((g) => g.items.map((i) => i.fact.id)),
    [["b", "e"], ["d", "a"], ["c"]],
  );
  assert.equal(groups[1]?.newest, "2026-01-07");
});

test("a row with no kind and no earlier version has no second line", () => {
  const t = task("t", "open", "x", [fact("f", "2026-11-12T08:00:00Z")]);
  assert.equal(itemDescription(rememberedItems([t])[0]!), ""); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- one fact in, one item out
});

test("a group folds after five items, never hiding a single row", () => {
  const six = Array.from({ length: 6 }, (_, i) => i);
  assert.equal(fold(six, false, 5).hidden, 0);
  assert.deepEqual(fold([...six, 6], false, 5), { shown: [0, 1, 2, 3, 4], hidden: 2 });
});
