import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryExchange, MemorySession } from "@octo/agent-client";
import { agentsLabel, endedNote, exchangeCount, filesLabel, foldText, formatCost, metaParts, newestFirst } from "./sessions";

const exchange = (over: Partial<MemoryExchange> = {}): MemoryExchange => ({
  id: "exc_1",
  turn_id: 1,
  message_id: 2,
  request: "r",
  answer: "a",
  answer_truncated: false,
  status: "completed",
  started_at: "2026-11-12T10:00:00.000Z",
  duration_ms: 12_000,
  model: "claude-sonnet",
  files: [],
  agents: [],
  tokens: { input: 1, output: 1 },
  cost_usd: null,
  ...over,
});

test("foldText keeps 12 lines, counts the rest, and closes a fence the cut opened", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const f = foldText(lines.join("\n"));
  assert.equal(f.hidden, 18);
  assert.equal(f.text.split("\n").length, 12);
  assert.deepEqual(foldText("a\nb\n\n\n"), { text: "a\nb\n\n\n", hidden: 0 });
  assert.equal(foldText(lines.slice(0, 12).join("\n")).hidden, 0, "exactly 12 lines is not folded");
  const code = ["intro", "```go", ...Array.from({ length: 20 }, (_, i) => `x${i}`), "```"].join("\n");
  const cut = foldText(code);
  assert.ok(cut.text.endsWith("\n```"), cut.text);
  assert.equal(cut.hidden, 11);
  const closed = foldText(["```", "a", "```", ...lines].join("\n"));
  assert.ok(!closed.text.endsWith("```"), "a fence that is already closed is left alone");
});

test("meta line leaves out what does not exist", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const bare = metaParts(exchange({ model: "", duration_ms: 0 }), now, "en-US");
  assert.equal(bare.length, 1);
  assert.match(bare[0] ?? "", /^Today /);
  const full = metaParts(exchange({ files: ["a", "b"], agents: ["x"], cost_usd: 0.0412 }), now, "en-US");
  assert.deepEqual(full.slice(1), ["claude-sonnet", "12s", "2 files changed", "1 sub-agent", "$0.04"]);
});

test("labels and counts", () => {
  assert.equal(filesLabel(0), null);
  assert.equal(filesLabel(1), "1 file changed");
  assert.equal(agentsLabel(["a", "b"]), "2 sub-agents");
  assert.equal(formatCost(null), null);
  assert.equal(formatCost(0.0012), "$0.0012");
  assert.equal(formatCost(3), "$3.00");
  assert.equal(exchangeCount(0), "empty");
  assert.equal(exchangeCount(1), "1 exchange");
  assert.equal(exchangeCount(4), "4 exchanges");
});

test("session notes and ordering", () => {
  const s = (id: string, started_at: string, over: Partial<MemorySession> = {}): MemorySession => ({
    id,
    title: id,
    started_at,
    ended_at: started_at,
    exchanges: 1,
    open: false,
    ...over,
  });
  assert.equal(endedNote(s("a", "2026-11-01T00:00:00Z", { open: true })), "Open");
  assert.equal(endedNote(s("a", "2026-11-01T00:00:00Z", { reason: "clear" })), "Ended with /clear");
  assert.equal(endedNote(s("a", "2026-11-01T00:00:00Z")), null);
  assert.deepEqual(
    newestFirst([s("old", "2026-11-01T00:00:00Z"), s("new", "2026-11-05T00:00:00Z")]).map((x) => x.id),
    ["new", "old"],
  );
});
