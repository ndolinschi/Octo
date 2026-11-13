import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryExchange, MemorySession } from "@octo/agent-client";
import { formatWhen } from "./dates";
import {
  answerPreview,
  endedNote,
  exchangeCount,
  exchangeRow,
  formatCost,
  metaLine,
  metaParts,
  needsFullRequest,
  newestFirst,
  requestLine,
  sessionRow,
  statusNote,
  toggleExpanded,
} from "./sessions";

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
const session = (over: Partial<MemorySession> = {}): MemorySession => ({
  id: "s",
  title: "t",
  started_at: "2026-11-12T10:00:00.000Z",
  ended_at: "2026-11-12T11:00:00.000Z",
  exchanges: 3,
  open: false,
  ...over,
});
const NOW = Date.parse("2026-11-12T12:00:00.000Z");

test("session row model: title, day and count, the current mark, the working glyph only on the current session", () => {
  const r = sessionRow(session({ open: true, exchanges: 5 }), NOW, true);
  assert.equal(r.title, "t");
  assert.match(r.description, /^Nov 12 · 5 exchanges$/);
  assert.equal(r.current, true);
  assert.equal(r.working, true);
  assert.equal(sessionRow(session({ open: false }), NOW, true).working, false);
  assert.equal(sessionRow(session({ open: true }), NOW, false).working, false);
  assert.match(sessionRow(session({ exchanges: 0 }), NOW, false).description, /· empty$/);
});

test("session row: the session entity decides which one is current (a resumed older session, not the newest open flag)", () => {
  const older = session({ id: "ses_old", open: false });
  const newer = session({ id: "ses_new", open: true });
  assert.equal(sessionRow(older, NOW, true, "ses_old").current, true);
  assert.equal(sessionRow(older, NOW, true, "ses_old").working, true);
  assert.equal(sessionRow(newer, NOW, true, "ses_old").current, false);
  assert.equal(sessionRow(newer, NOW, true, "ses_old").working, false);
  // Entity not loaded yet: the memory session's own flag.
  assert.equal(sessionRow(newer, NOW, false, null).current, true);
});

test("meta line: fixed order, parts that do not exist leave no separator, the cost is the last to survive", () => {
  const e = exchange({ duration_ms: 41_000, files: ["a", "b", "c"], cost_usd: 0.1832 });
  const parts = metaParts(e, "Sonnet 4", NOW);
  assert.equal(parts.length, 5);
  assert.deepEqual(parts.slice(1), ["Sonnet 4", "41s", "3 files", "$0.18"]);
  assert.equal(parts.at(-1), "$0.18");
  const bare = metaParts(exchange({ duration_ms: 0 }), "", NOW);
  assert.equal(bare.length, 1);
  const line = metaLine(metaParts(exchange({ duration_ms: 0, cost_usd: 0.0124 }), "", NOW));
  assert.ok(!line.startsWith(" · ") && !line.endsWith(" · "));
  assert.ok(line.endsWith("· $0.01"));
  assert.equal(metaLine(["a", "b"]), "a · b");
  assert.equal(metaParts(exchange({ files: ["x"] }), "m", NOW)[3], "1 file");
});

test("cost, counts and notes", () => {
  assert.equal(formatCost(null), null);
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.0012), "$0.0012");
  assert.equal(exchangeCount(0), "empty");
  assert.equal(exchangeCount(1), "1 exchange");
  assert.equal(endedNote(session({ open: true })), null);
  assert.equal(endedNote(session({ reason: "clear" })), "Ended with /clear");
  assert.equal(endedNote(session()), null);
  assert.match(statusNote("failed") ?? "", /Open it in the conversation/);
  assert.equal(statusNote("completed"), null);
});

test("sessions newest first, stable", () => {
  const list = [session({ id: "a", started_at: "2026-01-01T00:00:00Z" }), session({ id: "b", started_at: "2026-03-01T00:00:00Z" })];
  assert.deepEqual(
    newestFirst(list).map((s) => s.id),
    ["b", "a"],
  );
});

test("one exchange is open at a time: choosing the open one closes it, another replaces it", () => {
  assert.equal(toggleExpanded(null, "a"), "a");
  assert.equal(toggleExpanded("a", "b"), "b");
  assert.equal(toggleExpanded("b", "b"), null);
});

test("exchange row: request on one line, first line of prose under it, outcome, short time", () => {
  const long = "## Where\n\n- `src/a.ts` creates the cookie.\n";
  const r = exchangeRow(exchange({ request: "  Harden the\nlogin flow\n", answer: long }), NOW);
  assert.equal(r.title, "Harden the");
  assert.equal(r.description, "Where");
  assert.equal(r.outcome, "done");
  assert.equal(exchangeRow(exchange({ answer: "", status: "failed" }), NOW).description, "Failed before an answer");
  assert.equal(exchangeRow(exchange({ answer: "Half done", status: "stopped" }), NOW).outcome, "stopped");
  assert.equal(requestLine("\n\n  x   y \nz"), "x y");
});

test("answer preview skips fences, tables and rules and strips marks", () => {
  assert.equal(answerPreview("```ts\ncode\n```\n\n| a | b |\n|---|---|\n\n**Done.** See [the doc](http://x)."), "Done. See the doc.");
  assert.equal(answerPreview("---\n\n1. First step"), "First step");
  assert.equal(answerPreview("```\nonly code\n```"), "");
});

test("a request is repeated in the expanded view only when the row cut it", () => {
  assert.equal(needsFullRequest("Short."), false);
  assert.equal(needsFullRequest("a\nb"), true);
  assert.equal(needsFullRequest("x".repeat(91)), true);
});

test("the time at the right of a row: clock today, Yesterday, then the day", () => {
  assert.match(formatWhen("2026-11-12T09:15:00", NOW), /9:15/);
  assert.equal(formatWhen("2026-11-11T09:15:00", NOW), "Yesterday");
  assert.equal(formatWhen("2026-11-04T09:15:00", NOW), "Nov 4");
});
