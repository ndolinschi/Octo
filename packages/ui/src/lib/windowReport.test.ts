import assert from "node:assert/strict";
import test from "node:test";
import type { ContextBreakdown, ContextOverview } from "@octo/agent-client";
import { foldItems, ITEM_FOLD, openTarget, windowReportView } from "./windowReport";

const item = (id: string, tokens: number, over: Record<string, unknown> = {}) => ({ id, label: id, tokens, loaded: true, estimated: true, ...over });

const overview: ContextOverview = {
  window: 200_000,
  used: 60_000,
  source: "harness",
  categories: [
    {
      id: "tools",
      label: "Tool definitions",
      tokens: 9_000,
      items: [item("t1", 500, { group: "Harness tools" }), item("t2", 4_000, { group: "octo-harness" }), item("t3", 4_500)],
    },
    { id: "messages", label: "Conversation", tokens: 51_000 },
  ],
};

test("sections follow the headline rows and carry their items largest first, group in the title", () => {
  const r = windowReportView(overview);
  const tools = r.sections.find((s) => s.id === "tools");
  assert.ok(tools);
  assert.deepEqual(
    tools.items.map((i) => i.id),
    ["t3", "t2", "t1"],
  );
  assert.equal(tools.items[1]?.title, "octo-harness · t2");
  assert.equal(tools.items[0]?.title, "t3");
  // A category without items (a harness before decision 88) is still a section.
  assert.deepEqual(r.sections.find((s) => s.id === "messages")?.items, []);
  assert.equal(r.notLoaded.length, 0);
  assert.equal(r.largest.length, 0);
  assert.equal(r.buffer, null);
});

test("not_loaded, largest_messages and the buffer come from the breakdown shape", () => {
  const raw: ContextBreakdown = {
    agent_id: "a",
    model: "m",
    window_tokens: 200_000,
    used_tokens: 10_000,
    estimated: true,
    parts: [],
    categories: [{ id: "memory", label: "Memory", tokens: 10_000 }],
    not_loaded: [item("n1", 300, { loaded: false, path: "/memories/a.md", actions: ["open"] }), item("n2", 2_000, { loaded: false })],
    largest_messages: [
      { message_id: 7, role: "assistant", tokens: 900, preview: "Here is" },
      { message_id: 3, role: "user", tokens: 4_000, preview: "Please read" },
    ],
    buffer_tokens: 12_000,
  };
  const r = windowReportView(raw);
  assert.deepEqual(
    r.notLoaded.map((i) => i.id),
    ["n2", "n1"],
  );
  assert.equal(r.notLoaded[1]?.loaded, false);
  assert.deepEqual(r.notLoaded[1]?.open, { to: "memory-file", path: "a.md" });
  assert.deepEqual(
    r.largest.map((m) => [m.messageId, m.roleLabel]),
    [
      [3, "You"],
      [7, "Assistant"],
    ],
  );
  assert.equal(r.buffer, 12_000);
});

test("open targets: memory files lose their prefix, instruction files their folder label, other rows have none", () => {
  assert.deepEqual(openTarget({ path: "/memories/notes/x.md", actions: ["open"] }), { to: "memory-file", path: "notes/x.md" });
  assert.deepEqual(openTarget({ path: "app:docs/AGENTS.md", actions: ["open"] }), { to: "file", path: "docs/AGENTS.md" });
  assert.deepEqual(openTarget({ path: "C:/x/AGENTS.md", actions: ["open"] }), { to: "file", path: "C:/x/AGENTS.md" });
  assert.equal(openTarget({ path: "/memories/x.md" }), null);
  assert.equal(openTarget({ actions: ["open"] }), null);
});

test("folding: five rows, then 'Show all N' adds the rest", () => {
  const rows = Array.from({ length: 9 }, (_, i) => i);
  assert.deepEqual(foldItems(rows, false), { shown: rows.slice(0, ITEM_FOLD), hidden: 4 });
  assert.deepEqual(foldItems(rows, true), { shown: rows, hidden: 0 });
  assert.deepEqual(foldItems(rows.slice(0, 5), false), { shown: rows.slice(0, 5), hidden: 0 });
});
