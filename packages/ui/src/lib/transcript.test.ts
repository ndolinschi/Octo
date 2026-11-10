import { must } from "./must";
import type { ContentBlock, Message } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { SPAWN_TOOL } from "./tools";
import { buildTurns, latestReply, promptText, requestSummaries } from "./transcript";

let nextId = 1;
const msg = (role: "user" | "assistant", content: ContentBlock[], at: string): Message => ({ id: nextId++, agent_id: "a", role, content, created_at: at });
const user = (text: string, at: string) => msg("user", [{ type: "text", text }], at);
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const use = (id: string, name = "read_file"): ContentBlock => ({ type: "tool_use", id, name, input: {} });
const result = (id: string, isError = false): ContentBlock => ({ type: "tool_result", tool_use_id: id, content: "x", is_error: isError });
const T = (m: number) => `2026-11-10T10:${String(m).padStart(2, "0")}:00Z`;

test("a turn starts at each user text message; tool results do not start one", () => {
  const msgs = [
    user("first", T(0)),
    msg("assistant", [text("on it"), use("t1")], T(1)),
    msg("user", [result("t1")], T(2)),
    msg("assistant", [text("done")], T(3)),
    user("second", T(10)),
    msg("assistant", [text("ok")], T(11)),
  ];
  const turns = buildTurns(msgs);
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((t) => promptText(must(t.prompt))),
    ["first", "second"],
  );
  assert.deepEqual(
    must(turns[0]).items.map((i) => i.kind),
    ["text", "tools", "text"],
  );
  assert.equal(must(turns[0]).lastAt, T(3));
  assert.equal(must(turns[1]).lastAt, T(11));
});

test("a tool result extends the turn's last time", () => {
  const turns = buildTurns([user("go", T(0)), msg("assistant", [use("t1")], T(1)), msg("user", [result("t1")], T(5))]);
  assert.equal(must(turns[0]).lastAt, T(5));
});

test("assistant messages before any prompt form a prompt-less turn; an empty list has no turns", () => {
  assert.deepEqual(buildTurns([]), []);
  const first = msg("assistant", [text("hello")], T(0));
  const turns = buildTurns([first, user("hi", T(1))]);
  assert.equal(turns.length, 2);
  assert.equal(must(turns[0]).prompt, null);
  assert.equal(must(turns[0]).key, `t0-${first.id}`);
});

test("a user message's text blocks join with a blank line; none means no text", () => {
  const m = msg("user", [text("a"), result("x"), text("b")], T(0));
  assert.equal(promptText(m), "a\n\nb");
  assert.equal(promptText(msg("user", [result("x")], T(0))), "");
});

test("consecutive tool calls collapse into one group, across messages, until text intervenes", () => {
  const turns = buildTurns([
    user("go", T(0)),
    msg("assistant", [use("1"), use("2")], T(1)),
    msg("user", [result("1"), result("2")], T(2)),
    msg("assistant", [use("3"), text("   "), use("4")], T(3)),
    msg("assistant", [text("middle"), use("5")], T(4)),
  ]);
  const items = must(turns[0]).items;
  assert.deepEqual(
    items.map((i) => i.kind),
    ["tools", "text", "tools"],
  );
  assert.deepEqual(
    items.map((i) => (i.kind === "text" ? i.text : i.uses.map((u) => u.id).join(","))),
    ["1,2,3,4", "middle", "5"],
  );
});

test("blank assistant text is dropped, not shown as an empty block", () => {
  const turns = buildTurns([user("go", T(0)), msg("assistant", [text(" \n "), text("real")], T(1))]);
  assert.deepEqual(
    must(turns[0]).items.map((i) => i.kind),
    ["text"],
  );
});

test("spawn_agent calls form delegation groups, kept per message", () => {
  const turns = buildTurns([
    user("go", T(0)),
    msg("assistant", [use("s1", SPAWN_TOOL), use("s2", SPAWN_TOOL), use("r", "read_file")], T(1)),
    msg("assistant", [use("s3", SPAWN_TOOL)], T(2)),
  ]);
  const items = must(turns[0]).items;
  assert.deepEqual(
    items.map((i) => i.kind),
    ["delegations", "tools", "delegations"],
  );
  const [first] = items;
  assert.deepEqual(first && first.kind !== "text" ? first.uses.map((u) => u.id) : [], ["s1", "s2"]);
});

test("item keys are stable per message and block index", () => {
  const a = msg("assistant", [text("x"), use("1")], T(1));
  const turns = buildTurns([user("go", T(0)), a]);
  assert.deepEqual(
    must(turns[0]).items.map((i) => i.key),
    [`${a.id}.0`, `${a.id}.1`],
  );
});

test("request summaries: earlier requests are done and last from prompt to their last message", () => {
  const turns = buildTurns([user("one", T(0)), msg("assistant", [text("a")], T(4)), user("two", T(10)), msg("assistant", [text("b")], T(12))]);
  const [one, two] = requestSummaries(turns, false, "completed");
  assert.equal(must(one).state, "done");
  assert.equal(must(must(one).endedAt) - must(one).startedAt, 4 * 60_000);
  assert.equal(must(two).state, "done");
  assert.equal(must(one).text, "one");
});

test("only the last request is working, failed or stopped; a working one has no end", () => {
  const turns = buildTurns([user("one", T(0)), msg("assistant", [text("a")], T(1)), user("two", T(2)), msg("assistant", [text("b")], T(3))]);
  assert.deepEqual(
    requestSummaries(turns, true, null).map((r) => r.state),
    ["done", "working"],
  );
  assert.equal(must(requestSummaries(turns, true, null)[1]).endedAt, null);
  assert.deepEqual(
    requestSummaries(turns, false, "failed").map((r) => r.state),
    ["done", "failed"],
  );
  assert.deepEqual(
    requestSummaries(turns, false, "cancelled").map((r) => r.state),
    ["done", "stopped"],
  );
  assert.deepEqual(
    requestSummaries(turns, true, "failed").map((r) => r.state),
    ["done", "working"],
    "running wins over the previous turn's outcome",
  );
});

test("a request nobody answered yet has no end time; prompt-less turns are not requests", () => {
  const turns = buildTurns([msg("assistant", [text("stray")], T(0)), user("asked", T(1))]);
  const out = requestSummaries(turns, false, null);
  assert.equal(out.length, 1);
  assert.equal(must(out[0]).endedAt, null);
  assert.deepEqual(requestSummaries([], false, null), []);
});

test("latest reply: the last assistant text's first non-empty line, as plain text", () => {
  const msg = (id: number, role: "user" | "assistant", text: string | null): Message => ({
    id,
    agent_id: "o",
    role,
    content: text === null ? [{ type: "tool_use", id: `t${id}`, name: "read_file", input: {} }] : [{ type: "text", text }],
    created_at: `2026-11-10T10:0${id}:00Z`,
  });
  assert.equal(latestReply([]), null);
  assert.equal(latestReply([msg(1, "user", "hi")]), null);
  assert.deepEqual(latestReply([msg(1, "assistant", "\n## **Plan**\nmore"), msg(2, "assistant", null)]), { text: "Plan", at: "2026-11-10T10:01:00Z" });
  assert.equal(latestReply([msg(1, "assistant", "old"), msg(2, "assistant", "`new` reply")])?.text, "new reply");
});
