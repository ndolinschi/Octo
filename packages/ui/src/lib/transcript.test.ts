import { must } from "./must";
import type { ContentBlock, Message } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { SPAWN_TOOL } from "./tools";
import {
  buildTurns,
  turnDurationMs,
  latestReply,
  promptText,
  requestSummaries,
  compactionSlots,
  turnWarning,
  showRail,
  isInterruption,
  stepState,
  turnHead,
  isRestartInterruption,
  RESTART_INTERRUPTION,
  spawnStatus,
} from "./transcript";

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

test("latest reply: the first prose line of the last reply with text; headings, tables and code are skipped", () => {
  const msg = (id: number, role: "user" | "assistant", text: string | null): Message => ({
    id,
    agent_id: "o",
    role,
    content: text === null ? [{ type: "tool_use", id: `t${id}`, name: "read_file", input: {} }] : [{ type: "text", text }],
    created_at: `2026-11-10T10:0${id}:00Z`,
  });
  assert.equal(latestReply([]), null);
  assert.equal(latestReply([msg(1, "user", "hi")]), null);
  assert.deepEqual(latestReply([msg(1, "assistant", "\n## What's happening\nThe **refresh** races."), msg(2, "assistant", null)]), {
    text: "The refresh races.",
    at: "2026-11-10T10:01:00Z",
  });
  assert.equal(latestReply([msg(1, "assistant", "old"), msg(2, "assistant", "`new` reply")])?.text, "new reply");
  assert.equal(latestReply([msg(1, "assistant", "| a | b |\n|---|---|\n```ts\ncode\n```\n- first item")])?.text, "first item");
  assert.equal(latestReply([msg(1, "assistant", "earlier prose"), msg(2, "assistant", "## Only a heading")]), null, "the latest reply decides");
});

test("compactionSlots puts a marker before the first turn after it", () => {
  const slots = compactionSlots([1, 5, 9], [{ upto_message_id: 6 }, { upto_message_id: 2 }, { upto_message_id: 12 }]);
  assert.deepEqual(slots.get(2), [{ upto_message_id: 6 }]);
  assert.deepEqual(slots.get(1), [{ upto_message_id: 2 }]);
  assert.deepEqual(slots.get(3), [{ upto_message_id: 12 }]);
  assert.equal(compactionSlots([null, 4], [{ upto_message_id: 1 }]).get(1)?.length, 1);
});

test("turnWarning reads only warning: errors", () => {
  assert.equal(turnWarning("warning: ACP agent refused the MCP server"), "ACP agent refused the MCP server");
  assert.equal(turnWarning("rate limited"), null);
  assert.equal(turnWarning(null), null);
  assert.equal(turnWarning("warning:"), null);
});

test("an MCP-prefixed spawn_agent call renders as a delegation", () => {
  const msgs: Message[] = [
    { id: 1, agent_id: "o", role: "user", created_at: "2026-11-11T10:00:00Z", content: [{ type: "text", text: "Go" }] },
    {
      id: 2,
      agent_id: "o",
      role: "assistant",
      created_at: "2026-11-11T10:00:01Z",
      content: [{ type: "tool_use", id: "t1", name: "mcp__octo-harness__spawn_agent", input: { role: "Explorer" } }],
    },
  ];
  const item = buildTurns(msgs)[0]?.items[0];
  assert.equal(item?.kind, "delegations");
  assert.equal(item?.kind === "delegations" ? item.uses[0]?.name : null, "spawn_agent");
});

test("the rail shows from five requests (decision 57)", () => {
  assert.equal(showRail(0), false);
  assert.equal(showRail(3), false);
  assert.equal(showRail(4), false);
  assert.equal(showRail(5), true);
  assert.equal(showRail(12), true);
});

const err = (content: string) => ({ content, is_error: true });
const ok = (content: string) => ({ content, is_error: false });

test("a stop's interruption: the harness's own texts unless the turn failed, an agent's cancel answer only in a stopped turn", () => {
  // history.go interruptedResult (built-in loop, written before the next request) and acp_session.go finishLocked.
  assert.equal(isInterruption(err("interrupted: the tool call did not complete"), "cancelled"), true);
  assert.equal(isInterruption(err("interrupted: the tool call did not complete"), null), true);
  assert.equal(isInterruption(err("interrupted: the tool call did not complete"), "failed"), false);
  assert.equal(isInterruption(err("the agent stopped before this tool call finished"), "cancelled"), true);
  // An ACP agent's answer to session/cancel (Claude Code: "rejected").
  assert.equal(isInterruption(err("rejected"), "cancelled"), true);
  assert.equal(isInterruption(err("rejected"), "completed"), false);
  assert.equal(isInterruption(err("rejected"), null), false);
  assert.equal(isInterruption(err("[Request interrupted by user for tool use]"), "cancelled"), true);
  // A genuine failure in a stopped turn stays a failure; a success is never one.
  assert.equal(isInterruption(err("exit status 1: tests failed"), "cancelled"), false);
  assert.equal(isInterruption(ok("rejected"), "cancelled"), false);
});

test("a tool call's state from its result, the agent's run and the turn's ending", () => {
  assert.equal(stepState(undefined, true, null), "running");
  assert.equal(stepState(undefined, false, "cancelled"), "stopped");
  assert.equal(stepState(ok("12 passed"), false, "cancelled"), "done");
  assert.equal(stepState(err("rejected"), false, "cancelled"), "stopped");
  assert.equal(stepState(err("rejected"), false, "completed"), "error");
  assert.equal(stepState(err("exit status 2"), false, "cancelled"), "error");
  assert.equal(stepState(err("the agent stopped before this tool call finished"), false, "failed"), "error");
});

test("the head of a finished turn says how it ended", () => {
  assert.deepEqual(turnHead("completed", 8_000), { state: "done", label: "Worked for 8s" });
  assert.deepEqual(turnHead("cancelled", 8_400), { state: "stopped", label: "Stopped after 8s" });
  assert.deepEqual(turnHead("failed", 75_000), { state: "failed", label: "Failed after 1m 15s" });
  // Unknown ending (an earlier turn after a reload): a stopped step means the turn was cut.
  assert.deepEqual(turnHead(null, 8_000, ["done", "stopped"]), { state: "stopped", label: "Stopped after 8s" });
  assert.deepEqual(turnHead(null, 8_000, ["done", "error"]), { state: "done", label: "Worked for 8s" });
});

test("P1-1: a turn the harness closed after a restart says so in its head", () => {
  assert.deepEqual(turnHead("failed", 12_000, ["stopped"], { interrupted: true }), {
    state: "failed",
    label: "Interrupted after 12s — Octo's local service restarted",
  });
  // Only a failed ending is a restart's: a later stop or completion of the same request says what it was.
  assert.deepEqual(turnHead("cancelled", 12_000, [], { interrupted: true }), { state: "stopped", label: "Stopped after 12s" });
  assert.deepEqual(turnHead("failed", 12_000, [], {}), { state: "failed", label: "Failed after 12s" });
  assert.equal(isRestartInterruption(RESTART_INTERRUPTION), true);
  assert.equal(isRestartInterruption(` ${RESTART_INTERRUPTION}\n`), true);
  assert.equal(isRestartInterruption("The connection to the model broke off."), false);
  assert.equal(isRestartInterruption(null), false);
});

test("a delegation without an agent settles from its result; a finished turn never leaves it pending", () => {
  const refused = err("spawn_agent requires role, title and task, and tier if given (auto|fast|balanced|deep)");
  assert.equal(spawnStatus(undefined, refused, true, null), "failed");
  assert.equal(spawnStatus(undefined, refused, false, "completed"), "failed");
  assert.equal(spawnStatus(undefined, ok("report"), false, "completed"), "completed");
  assert.equal(spawnStatus(undefined, undefined, true, null), "pending");
  assert.equal(spawnStatus(undefined, undefined, false, "cancelled"), "cancelled");
  assert.equal(spawnStatus(undefined, undefined, false, null), "cancelled");
  assert.equal(spawnStatus(undefined, undefined, false, "failed"), "failed");
  assert.equal(spawnStatus(undefined, err("rejected"), false, "cancelled"), "cancelled");
  // With an agent, its own status wins.
  assert.equal(spawnStatus("running", undefined, true, null), "running");
  assert.equal(spawnStatus("failed", err("sub-agent failed: x"), false, "completed"), "failed");
  assert.equal(spawnStatus("cancelled", err("sub-agent stopped by the user"), false, "completed"), "cancelled");
});

test("B4: a finished turn's duration runs to its end, not to its last item", () => {
  const start = Date.parse("2026-11-10T10:00:00Z");
  const lastAt = "2026-11-10T10:00:01Z";
  // Stopped 5 s in, one second after the last message: the agent's finished_at says so.
  assert.equal(turnDurationMs(start, { live: false, lastAt, finishedAt: "2026-11-10T10:00:05Z" }), 5_000);
  // The stored exchange wins (after a reload, for an earlier turn too).
  assert.equal(turnDurationMs(start, { live: false, lastAt, stored: { status: "cancelled", startedAt: start, ms: 5_400 } }), 5_400);
  // A finished_at from before this turn (an older turn's) is not its end.
  assert.equal(turnDurationMs(start, { live: false, lastAt, finishedAt: "2026-11-10T09:00:00Z" }), 1_000);
  assert.equal(turnDurationMs(start, { live: true, lastAt, finishedAt: null }), null);
  assert.equal(turnDurationMs(null, { live: false, lastAt }), null);
});
