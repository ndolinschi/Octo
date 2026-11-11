import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@octo/agent-client";
import { activityLine, labelParts, QUIET_MS, runningToolOf, toolActivity, type ActivityInput } from "./activity";

const base: ActivityInput = { activity: undefined, runningTool: null, writing: false, thinking: false, waitingOn: [], quietMs: 0, agentName: "Claude Code" };

test("tool calls read as what is happening now", () => {
  assert.equal(toolActivity("read_file", { path: "src/x.ts" }), "Reading src/x.ts");
  assert.equal(toolActivity("bash", { command: "pnpm test\necho done" }), "Running `pnpm test`");
  assert.equal(toolActivity("list_dir", { path: "." }), "Listing the folder");
  assert.equal(toolActivity("spawn_agent", { role: "Test runner" }), "Starting Test runner");
  assert.equal(toolActivity("execute", { title: "pnpm lint" }), "Running `pnpm lint`");
  assert.equal(toolActivity("read", { title: "Read src/server/routes.ts" }), "Read src/server/routes.ts");
  assert.equal(toolActivity("mystery", {}), "Using mystery");
});

test("the harness's label wins; without it the transcript's state is used; never a bare Working", () => {
  assert.deepEqual(activityLine({ ...base, activity: { kind: "tool", label: "Reading a.ts" } }), { kind: "tool", label: "Reading a.ts" });
  assert.deepEqual(activityLine({ ...base, activity: { kind: "waiting_approval", label: "" } }), { kind: "approval", label: "Waiting for your approval" });
  assert.equal(activityLine({ ...base, activity: { kind: "quiet", label: "" } }).label, "Still working — no output from Claude Code yet");
  assert.equal(activityLine({ ...base, runningTool: { name: "read_file", input: { path: "b.ts" } } }).label, "Reading b.ts");
  assert.equal(activityLine({ ...base, waitingOn: ["Auditor", "Runner"] }).label, "Waiting on Auditor, Runner");
  assert.equal(activityLine({ ...base, writing: true }).label, "Writing…");
  assert.equal(activityLine(base).label, "Thinking…");
  assert.equal(activityLine({ ...base, quietMs: QUIET_MS }).kind, "quiet");
});

const m = (id: number, role: Message["role"], content: Message["content"]): Message => ({ id, agent_id: "a", role, content, created_at: "t" });

test("runningToolOf finds the newest unanswered call in the newest assistant message only", () => {
  const call = (id: string) => ({ type: "tool_use" as const, id, name: "read_file", input: { path: id } });
  assert.equal(runningToolOf([]), null);
  assert.equal(runningToolOf([m(1, "assistant", [call("t1")])])?.id, "t1");
  assert.equal(
    runningToolOf([m(1, "assistant", [call("t1")]), m(2, "user", [{ type: "tool_result", tool_use_id: "t1", content: "", is_error: false }])]),
    null,
  );
  assert.equal(runningToolOf([m(1, "assistant", [call("t1"), call("t2")])])?.id, "t2");
  assert.equal(runningToolOf([m(1, "assistant", [call("t1")]), m(2, "assistant", [{ type: "text", text: "x" }])]), null);
});

test("labelParts marks backticked commands as code", () => {
  assert.deepEqual(labelParts("Running `pnpm test`"), [
    { text: "Running ", code: false },
    { text: "pnpm test", code: true },
  ]);
});
