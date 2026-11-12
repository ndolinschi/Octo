import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryHit, Note } from "@octo/agent-client";
import {
  afterName,
  dedupeHits,
  emptyText,
  firstSentence,
  groupHits,
  matchWord,
  noteHits,
  plainText,
  passageAround,
  searchable,
  splitFactId,
  toUiHit,
  windowAround,
} from "./search";

const base = { title: "t", snippet: "s", date: "2026-01-01" };
const hit = (over: Partial<MemoryHit> & Pick<MemoryHit, "kind" | "id">): MemoryHit => ({ ...base, ...over });
const note = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  title: `Note ${id}`,
  description: "",
  description_auto: false,
  tags: [],
  pinned: false,
  size: 1,
  author: "user",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  last_read_at: "",
  read_count: 0,
  ...over,
});

test("hits group by kind in a fixed order, messages join exchanges, empty groups vanish, superseded come last", () => {
  const hits = [
    hit({ kind: "file", id: "a.md" }),
    hit({ kind: "fact", id: "t/f1", superseded: true }),
    hit({ kind: "message", id: "5" }),
    hit({ kind: "fact", id: "t/f2" }),
    hit({ kind: "exchange", id: "exc_1", session_id: "s1" }),
    hit({ kind: "task", id: "t" }),
  ].map((h) => toUiHit(h, "x"));
  const groups = groupHits([...hits, ...noteHits([note("n1", { title: "Auth rules" })], "auth")]);
  assert.deepEqual(
    groups.map((g) => g.id),
    ["exchanges", "knowledge", "files", "notes"],
  );
  assert.deepEqual(
    groups[0]?.hits.map((h) => h.key),
    ["message:5", "exchange:exc_1"],
  );
  assert.deepEqual(
    groups[1]?.hits.map((h) => h.key),
    ["fact:t/f2", "task:t", "fact:t/f1"],
  );
  assert.deepEqual(
    groupHits(hits.filter((h) => h.group === "files")).map((g) => g.id),
    ["files"],
  );
  assert.deepEqual(groupHits([]), []);
});

test("where each hit opens", () => {
  assert.deepEqual(toUiHit(hit({ kind: "exchange", id: "e", session_id: "s" }), "x").target, { to: "session", sessionId: "s", exchangeId: "e" });
  assert.equal(toUiHit(hit({ kind: "exchange", id: "e" }), "x").target, null);
  assert.deepEqual(toUiHit(hit({ kind: "fact", id: "t/f2", task_id: "t" }), "x").target, { to: "task", taskId: "t", factId: "f2" });
  assert.deepEqual(toUiHit(hit({ kind: "task", id: "t" }), "x").target, { to: "task", taskId: "t", factId: null });
  assert.deepEqual(toUiHit(hit({ kind: "file", id: "n/a.md" }), "x").target, { to: "file", path: "n/a.md" });
  assert.deepEqual(toUiHit(hit({ kind: "message", id: "42" }), "x").target, { to: "message", messageId: 42 });
  assert.equal(toUiHit(hit({ kind: "message", id: "x" }), "x").target, null);
  assert.deepEqual(splitFactId("a/b"), { taskId: "a", factId: "b" });
  assert.equal(splitFactId("a/"), null);
});

test("notes: every word must match title, description or a tag; newest first; capped", () => {
  const notes = [
    note("a", { title: "Release checklist", updated_at: "2026-01-01" }),
    note("b", { description: "How to release safely", tags: ["ops"], updated_at: "2026-02-01" }),
    note("c", { title: "Unrelated" }),
  ];
  assert.deepEqual(
    noteHits(notes, "release").map((h) => h.key),
    ["note:b", "note:a"],
  );
  assert.deepEqual(
    noteHits(notes, "release ops").map((h) => h.key),
    ["note:b"],
  );
  assert.equal(noteHits(notes, "release", 1).length, 1);
  assert.deepEqual(noteHits(notes, "  "), []);
  assert.deepEqual(noteHits(notes, "ops")[0]?.target, { to: "note", noteId: "b" });
});

test("the marked word, the minimum query and the empty sentence", () => {
  assert.equal(matchWord("Refresh tokens live 30 days", "zzz tokens"), "tokens");
  assert.equal(matchWord("abc", "x"), "");
  assert.equal(searchable("a"), false);
  assert.equal(searchable(" ab "), true);
  assert.equal(emptyText("zz", "nothing in memory matches"), "Nothing in memory matches “zz”");
  assert.equal(emptyText(" zz ", undefined), "Nothing in memory matches “zz”");
});

test("a long snippet is cut around the match so a one-line row shows it", () => {
  const text = `${"lorem ipsum ".repeat(20)}NEEDLE ${"dolor sit ".repeat(20)}`;
  const w = windowAround(text, "needle", 40);
  assert.ok(w.toLowerCase().includes("needle"));
  assert.ok(w.startsWith("…") && w.endsWith("…"));
  assert.ok(w.length <= 42);
  assert.equal(windowAround("short text", "text"), "short text");
  assert.equal(windowAround("x".repeat(100), "zz", 20), "x".repeat(100), "no match: unchanged");
  assert.ok(!windowAround(`needle ${"x ".repeat(50)}`, "needle", 30).startsWith("…"));
});

test("hits show plain words: Markdown marks are stripped from snippets and titles", () => {
  assert.equal(plainText("## What's **happening**\n\nsee [the doc](http://x) and `code`"), "What's happening\nsee the doc and code");
  const h = toUiHit(hit({ kind: "message", id: "1", snippet: "Plan - **Refresh** tokens", title: "## Plan" }), "refresh");
  assert.equal(h.name, "Plan");
  assert.equal(h.passage, "Refresh tokens");
});

test("a task hit: line 1 is its title; a match in the goal is shown as a passage of one sentence, never glued to the title", () => {
  const h = toUiHit(
    hit({
      kind: "task",
      id: "t",
      title: "Refresh tokens rotate on every use",
      snippet: "Refresh tokens rotate on every use Rotate the token on every use. Keep the 30-day lifetime. Postgres only, no Redis",
    }),
    "lifetime",
  );
  assert.equal(h.name, "Refresh tokens rotate on every use");
  assert.equal(h.nameWord, "");
  assert.equal(h.passage, "Keep the 30-day lifetime.");
  assert.equal(h.passageWord, "lifetime");
});

test("a match in the name leaves line 2 to the usual second line: the goal's first sentence for a task", () => {
  const h = toUiHit(
    hit({ kind: "task", id: "t", title: "Refresh tokens rotate", snippet: "Refresh tokens rotate Rotate on every use. Keep the lifetime." }),
    "refresh",
  );
  assert.equal(h.nameWord, "refresh");
  assert.equal(h.passage, null);
  assert.equal(h.context, "Rotate on every use.");
});

test("a fact is its own name and its task is the second line; an exchange has none when the match is in the request", () => {
  const f = toUiHit(hit({ kind: "fact", id: "t/f1", task_id: "t", title: "Billing webhooks", snippet: "Stripe retries for up to 3 days" }), "stripe");
  assert.equal(f.name, "Stripe retries for up to 3 days");
  assert.equal(f.nameWord, "stripe");
  assert.equal(f.passage, null);
  assert.equal(f.context, "Billing webhooks");
  const e = toUiHit(
    hit({ kind: "exchange", id: "e", session_id: "s", title: "Harden the login flow", snippet: "Harden the login flow. Refresh tokens must be single use." }),
    "harden",
  );
  assert.equal(e.name, "Harden the login flow");
  assert.equal(e.passage, null);
  assert.equal(e.context, "");
  const e2 = toUiHit(
    hit({
      kind: "exchange",
      id: "e",
      session_id: "s",
      title: "Harden the login flow",
      snippet: "…cookie is SameSite=Lax. Lax still blocks cross-site POSTs, which is the case that matters.",
    }),
    "cross-site",
  );
  assert.equal(e2.passage, "Lax still blocks cross-site POSTs, which is the case that matters.");
});

test("one hit per item", () => {
  const a = toUiHit(hit({ kind: "task", id: "t" }), "x");
  assert.deepEqual(
    dedupeHits([a, { ...a, name: "second" }, toUiHit(hit({ kind: "file", id: "f" }), "x")]).map((h) => h.key),
    ["task:t", "file:f"],
  );
});

test("passages stay inside one sentence; names are cut off the snippet's start", () => {
  assert.equal(firstSentence("Rotate on every use. Keep it."), "Rotate on every use.");
  assert.equal(passageAround("One. Two has the needle in it. Three.", "needle"), "Two has the needle in it.");
  assert.equal(afterName("Plan", "Plan Rotate on use"), "Rotate on use");
  assert.equal(afterName("Plan", "…other text"), "other text");
});

test("a line break in a snippet is a field boundary: a passage never runs across it", () => {
  const h = toUiHit(
    hit({
      kind: "task",
      id: "t",
      title: "Billing webhooks",
      snippet: "Billing webhooks\nProcess each event once and keep the log\nA unique index on stripe_events is the lock\nToken refresh logs people out",
    }),
    "lock",
  );
  assert.equal(h.passage, "A unique index on stripe_events is the lock");
  assert.equal(passageAround("one field\nsecond needle field\nthird", "needle"), "second needle field");
  assert.equal(firstSentence("First field\nSecond field"), "First field");
});

test("a list marker is not part of a passage", () => {
  assert.equal(passageAround("- Refresh tokens: 30 days", "refresh"), "Refresh tokens: 30 days");
});
