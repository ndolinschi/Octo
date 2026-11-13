import assert from "node:assert/strict";

const ok = (value: unknown, message?: string) => assert.equal(Boolean(value), true, message);
const match = (text: string, re: RegExp) => assert.equal(re.test(text), true, `${JSON.stringify(text)} does not match ${String(re)}`);
import test from "node:test";
import { completionMode, demoLatency, demoSuggest } from "./completion";
import { addSession, buildSessions, mainSessions, makeCurrent } from "./memorySessions";
import { buildFiles, buildTasks, memoryMode, receipt, search, type Store } from "./memory";

test("demo completion: modes from the query string", () => {
  assert.equal(completionMode("?demo=1"), "on");
  assert.equal(completionMode("?demo=1&completion=off"), "off");
  assert.equal(completionMode("?completion=budget"), "budget");
  assert.equal(completionMode("?completion=nope"), "on");
});

test("demo completion: deterministic, 150 to 400 ms", () => {
  for (const p of ["", "a", "export function clamp(", "x".repeat(500)]) {
    const ms = demoLatency(p);
    ok(ms >= 150 && ms <= 400, String(ms));
    assert.equal(demoLatency(p), ms);
  }
});

test("demo completion: function bodies, repeated lines, endings, nothing mid-line", () => {
  match(demoSuggest("export async function revokeRefresh(", "\n") ?? "", /^raw: string\) \{\n {2}const token/);
  match(demoSuggest("  function cla", "\n") ?? "", /^mp\(value: number/);
  assert.equal(demoSuggest("const access = 1;\nconst acc", "\n"), "ess = 1;");
  assert.equal(demoSuggest("  return ", "\n}"), "null;");
  assert.equal(demoSuggest("  return ", "x;\n}"), null, "mid-line");
  assert.equal(demoSuggest("zzz", ""), null);
});

const requests = Array.from({ length: 8 }, (_, i) => ({
  id: 10 + i * 2,
  text: `Request number ${i}. Please do the thing.`,
  at: new Date(2026, 10, i + 1).toISOString(),
}));
const now = Date.parse("2026-11-11T12:00:00Z");
const store: Store = { tasks: buildTasks(requests, now), files: buildFiles(now), requests, replies: [] };

test("demo memory: 30 tasks, 80 facts with superseded ones, 12 files", () => {
  assert.equal(memoryMode("?memory=empty"), "empty");
  assert.equal(store.tasks.length, 30);
  const facts = store.tasks.flatMap((t) => t.facts);
  assert.equal(facts.length, 80);
  ok(facts.filter((f) => f.superseded_by).length >= 10);
  ok(
    facts.some((f) => f.superseded_by?.includes("/")),
    "one fact is superseded by a fact of another task",
  );
  assert.equal(store.files.length, 12);
  assert.equal(new Set(store.tasks.map((t) => t.id)).size, 30);
});

test("demo memory: quotes are exact substrings of the request they link to", () => {
  for (const t of store.tasks) {
    for (const q of t.quotes) {
      const r = requests.find((x) => x.id === q.message_id);
      ok(r?.text.includes(q.text), `${t.id}: ${q.text}`);
    }
  }
});

test("demo memory: search finds, filters by kind and date, puts superseded facts last, says when nothing matches", () => {
  const port = search(store, { q: "dashboard port" });
  ok(port.hits.length > 0);
  const tokens = search(store, { q: "refresh tokens live", in: ["facts"] });
  ok(tokens.hits.every((h) => h.kind === "fact"));
  const firstSuperseded = tokens.hits.findIndex((h) => h.superseded);
  ok(firstSuperseded > 0 && tokens.hits.slice(firstSuperseded).every((h) => h.superseded));
  assert.deepEqual(search(store, { q: "kubernetes helm chart" }), { hits: [], message: "nothing in memory matches" });
  const recent = search(store, { q: "refresh", after: "2026-11-05" });
  ok(recent.hits.every((h) => h.date >= "2026-11-05"));
});

test("demo memory: receipts — none for the oldest turn, one full-mode turn, window blocks under their caps", () => {
  let threw = false;
  try {
    receipt(store, 10);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "no receipt for the oldest turn");
  assert.equal(receipt(store, 12).mode, "full");
  const r = receipt(store, 24);
  assert.equal(r.mode, "window");
  assert.deepEqual(
    r.blocks.map((b) => b.name),
    ["memory_index", "open_tasks", "recent_window", "facts", "current_turn"],
  );
  for (const b of r.blocks) ok(b.cap === 0 || b.tokens <= b.cap, b.name);
  assert.equal(r.blocks.find((b) => b.name === "recent_window")?.count, 5);
});

test("demo sessions: memory sessions are main sessions, one current; new and resume move it", () => {
  const d = buildSessions([10, 12], now);
  const list = mainSessions(d, 2);
  assert.equal(list.filter((x) => x.current).length, 1);
  ok(list.every((x) => x.kind === "main"));
  const current = list.find((x) => x.current);
  assert.equal(current?.children, 2);
  assert.equal(current?.can_message, true);
  assert.equal(list.find((x) => !x.current)?.message_blocked?.code, "not_current");
  const made = addSession(d, "Fresh", now);
  assert.equal(mainSessions(d, 0).find((x) => x.current)?.id, made.id);
  assert.equal(makeCurrent(d, "ses_2"), true);
  assert.equal(mainSessions(d, 0).find((x) => x.current)?.id, "ses_2");
  assert.equal(makeCurrent(d, "nope"), false);
});
